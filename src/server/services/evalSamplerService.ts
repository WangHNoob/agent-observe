import type pg from "pg";
import type { Database } from "../db.js";

/**
 * 在线评测采样器（flywheel 03-P4，与方案 01 §2.2 协同）。
 *
 * 职责（两案择一，避免双写）：采样器落在观测台——它天然只读共享表
 * （agent_traces / agent_spans / executions），把生产 query trace 判分候选
 * 写入自有表 obs_metrics.eval_candidates；design-agent 侧只负责信号落库
 * （executions.requirement_hash / outcome_signal / execution_outcome 事件，
 * 01-P4 已交付），观测台负责「候选池展示页 + 导出」。
 *
 * 采样条件（方案 01 §2.2 子集，共享表可得的信号）：
 *   - faq_miss：trace 属性带 faq 相关标记（attributes::text 匹配 faq），
 *   - tool_chain：同一 trace 的工具调用 span ≥ 2（spans phase=pre_tool_execution），
 *   - plain_query：其余完成的 query/design execution（低门槛保底）。
 *   「用户明确评价 / 复制点赞」类 UI 信号不在共享表，留待 design-agent
 *   前端事件接入（文档注明）。
 *
 * 护栏：按 (user_id, 归一化 question) 在 dedupeDays 内去重；单轮 maxPerRun 上限；
 * 只采 status=ok 的 trace + completed 的 execution；写路径全部走 obs_manager。
 */

export type EvalCandidateSource = "faq_miss" | "tool_chain" | "plain_query";
export type EvalCandidateStatus = "pending" | "exported" | "dismissed";

export interface EvalCandidate {
  id: string;
  traceId: string;
  executionId: string;
  userId: string;
  sessionId: string;
  mode: string;
  question: string;
  answer: string;
  source: EvalCandidateSource;
  status: EvalCandidateStatus;
  createdAt: string;
  exportedAt: string | null;
}

export interface EvalSamplerOptions {
  /** 采样窗口（小时），默认 24 */
  windowHours?: number;
  /** 单轮最多采样数，默认 20 */
  maxPerRun?: number;
  /** 同 (user, question) 去重窗口（天），默认 90 */
  dedupeDays?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

const CANDIDATES_TABLE = "obs_metrics.eval_candidates";

export class EvalSamplerService {
  private readonly windowHours: number;
  private readonly maxPerRun: number;
  private readonly dedupeDays: number;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;

  constructor(
    private readonly db: Database,
    private readonly managerDb: Database | undefined,
    options: EvalSamplerOptions = {},
  ) {
    this.windowHours = options.windowHours ?? 24;
    this.maxPerRun = options.maxPerRun ?? 20;
    this.dedupeDays = options.dedupeDays ?? 90;
    this.log = options.log ?? (() => {});
  }

  /** 采样写入是否可用：需要 obs_manager 连接。 */
  get enabled(): boolean {
    return this.managerDb != null;
  }

  /**
   * 跑一轮采样：扫描窗口内完成的 execution trace，按条件判为候选并写入。
   * @returns 本轮采样的候选数量与各来源计数。
   */
  async runSampling(now = new Date()): Promise<{ sampled: number; bySource: Record<EvalCandidateSource, number> }> {
    if (!this.managerDb) {
      return { sampled: 0, bySource: { faq_miss: 0, tool_chain: 0, plain_query: 0 } };
    }
    const since = new Date(now.getTime() - this.windowHours * 3_600_000).toISOString();

    // 1) 候选 executions（共享表只读）：完成的 query/design execution + 对应 trace
    const candidates = await this.db.query<{
      trace_id: string;
      execution_id: string;
      user_id: string;
      session_id: string;
      mode: string;
      requirement: string | null;
      output: string | null;
      attributes: Record<string, unknown> | string | null;
      started_at: string;
      span_count: number;
    }>(
      `SELECT t.id AS trace_id,
              t.execution_id,
              t.user_id,
              t.session_id,
              COALESCE(e.mode, 'query') AS mode,
              COALESCE(e.request_payload->>'requirement', '') AS requirement,
              COALESCE(e.result_payload->>'output', '') AS output,
              t.attributes,
              t.started_at,
              (SELECT COUNT(*)::int
                 FROM agent_spans s
                WHERE s.trace_id = t.id
                  AND s.phase = 'pre_tool_execution') AS span_count
         FROM agent_traces t
         JOIN executions e ON e.id = t.execution_id
        WHERE t.started_at >= $1
          AND t.status = 'ok'
          AND e.status = 'completed'
          AND COALESCE(e.mode, 'query') IN ('query', 'design', 'table')
        ORDER BY t.started_at DESC
        LIMIT 500`,
      [since],
    );

    const bySource: Record<EvalCandidateSource, number> = { faq_miss: 0, tool_chain: 0, plain_query: 0 };
    let sampled = 0;

    for (const row of candidates.rows) {
      if (sampled >= this.maxPerRun) break;
      const question = String(row.requirement ?? "").trim();
      if (question.length === 0) continue;
      const source = classifySource(row.attributes, Number(row.span_count ?? 0));

      // 2) 去重：同 (user, question) 在 dedupeDays 内已采样过则跳过
      const dup = await this.managerDb.query(
        `SELECT 1 FROM ${CANDIDATES_TABLE}
          WHERE user_id = $1 AND question = $2
            AND created_at > NOW() - ($3 || ' days')::interval
          LIMIT 1`,
        [String(row.user_id), question, this.dedupeDays],
      );
      if (dup.rows.length > 0) continue;

      const id = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await this.managerDb.query(
        `INSERT INTO ${CANDIDATES_TABLE}
          (id, trace_id, execution_id, user_id, session_id, mode, question, answer, source, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          String(row.trace_id),
          String(row.execution_id ?? ""),
          String(row.user_id),
          String(row.session_id ?? ""),
          String(row.mode),
          question,
          String(row.output ?? "").slice(0, 8000),
          source,
          new Date().toISOString(),
        ],
      );
      bySource[source] += 1;
      sampled += 1;
    }

    this.log("info", `[eval-sampler] sampled ${sampled} candidates (${JSON.stringify(bySource)})`);
    return { sampled, bySource };
  }

  /** 候选池列表（自有表只读查询）。 */
  async listCandidates(options: {
    status?: EvalCandidateStatus;
    limit?: number;
    offset?: number;
  } = {}): Promise<EvalCandidate[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const where = options.status ? "WHERE status = $1" : "";
    const params = options.status ? [options.status, limit, offset] : [limit, offset];
    const { rows } = await this.db.query(
      `SELECT id, trace_id, execution_id, user_id, session_id, mode,
              question, answer, source, status, created_at, exported_at
         FROM ${CANDIDATES_TABLE}
         ${where}
        ORDER BY created_at DESC
        LIMIT $${options.status ? 2 : 1} OFFSET $${options.status ? 3 : 2}`,
      params,
    );
    return rows.map(mapCandidate);
  }

  /** 标记候选状态（exported / dismissed），需要 obs_manager。 */
  async markStatus(id: string, status: EvalCandidateStatus, actor: string): Promise<boolean> {
    if (!this.managerDb) return false;
    const { rows } = await this.managerDb.query(
      `UPDATE ${CANDIDATES_TABLE}
          SET status = $2,
              exported_at = CASE WHEN $2 = 'exported' THEN NOW() ELSE exported_at END,
              updated_by = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [id, status, actor],
    );
    return rows.length > 0;
  }

  /**
   * 导出候选池（pending/exported 均可）：question + answer + trace 溯源，
   * 格式与 knowledge-hub evals 兼容（人工改写为 golden case：补充
   * expectTitleSubstrings / 数值断言后并入 retrieval-gold.json）。
   */
  async exportCandidates(): Promise<{
    generatedAt: string;
    note: string;
    candidates: Array<{
      id: string;
      question: string;
      answer: string;
      traceId: string;
      executionId: string;
      mode: string;
      source: EvalCandidateSource;
      createdAt: string;
    }>;
  }> {
    const rows = await this.listCandidates({ status: "pending", limit: 500 });
    return {
      generatedAt: new Date().toISOString(),
      note: "观测台在线评测采样候选：人工确认后改写为 knowledge-hub golden case（补断言），凭 traceId/executionId 溯源；禁止静默自动入库。",
      candidates: rows.map((row) => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
        traceId: row.traceId,
        executionId: row.executionId,
        mode: row.mode,
        source: row.source,
        createdAt: row.createdAt,
      })),
    };
  }
}

/** 采样来源分类：faq 属性标记 > 工具链 ≥ 2 > 保底 plain。 */
export function classifySource(
  attributes: Record<string, unknown> | string | null | undefined,
  spanCount: number,
): EvalCandidateSource {
  const text = typeof attributes === "string" ? attributes : JSON.stringify(attributes ?? {});
  if (/faq/i.test(text) && /(hit|miss|match)/i.test(text)) return "faq_miss";
  if (spanCount >= 2) return "tool_chain";
  return "plain_query";
}

function mapCandidate(row: pg.QueryResultRow): EvalCandidate {
  return {
    id: String(row.id),
    traceId: String(row.trace_id ?? ""),
    executionId: String(row.execution_id ?? ""),
    userId: String(row.user_id ?? ""),
    sessionId: String(row.session_id ?? ""),
    mode: String(row.mode ?? "query"),
    question: String(row.question ?? ""),
    answer: String(row.answer ?? ""),
    source: String(row.source ?? "plain_query") as EvalCandidateSource,
    status: String(row.status ?? "pending") as EvalCandidateStatus,
    createdAt: String(row.created_at ?? ""),
    exportedAt: row.exported_at ? String(row.exported_at) : null,
  };
}
