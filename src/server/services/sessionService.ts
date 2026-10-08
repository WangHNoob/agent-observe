import type pg from "pg";
import type { Database } from "../db.js";

export interface SessionFilters {
  mode?: string;
  status?: string;
  /** 需求/输出模糊匹配（ILIKE） */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface SessionListItem {
  id: string;
  requirement: string;
  mode: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  executionCount: number;
  traceCount: number;
  inputTokens: number;
  outputTokens: number;
  /** pg bigint SUM → string，全链路保持 string（前端 fmtMicrosCost 渲染） */
  costMicros: string;
}

export interface SessionDetail {
  session: {
    id: string;
    userId: string;
    requirement: string;
    mode: string;
    role: string;
    status: string;
    output: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  };
  traces: {
    id: string;
    name: string;
    mode: string;
    status: string;
    executionId: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    inputTokens: number;
    outputTokens: number;
    costMicros: string;
  }[];
  executions: {
    id: string;
    status: string;
    mode: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    /** 由 traces 按 executionId 分组（TS 侧推导，不加 SQL） */
    traceIds: string[];
  }[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    costMicros: string;
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 先按筛选分页取页内会话，再按页内行 LATERAL 聚合执行/trace/cost——避免对全量匹配行做 GROUP BY。 */
function sessionListPageSql(): string {
  return `
  WITH page AS (
    SELECT id, requirement, mode, role, status, created_at, updated_at
    FROM sessions
    WHERE ($1::text IS NULL OR mode = $1)
      AND ($2::text IS NULL OR status = $2)
      AND ($3::text IS NULL OR requirement ILIKE '%' || $3 || '%' OR output ILIKE '%' || $3 || '%')
    ORDER BY created_at DESC
    LIMIT $4 OFFSET $5
  )
  SELECT p.id, p.requirement, p.mode, p.role, p.status,
         p.created_at AS "createdAt", p.updated_at AS "updatedAt",
         COALESCE(x.n, 0)::int AS "executionCount",
         COALESCE(t.n, 0)::int AS "traceCount",
         COALESCE(t.in_tok, 0)::int AS "inputTokens",
         COALESCE(t.out_tok, 0)::int AS "outputTokens",
         COALESCE(t.cost, 0)::text AS "costMicros"
  FROM page p
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n FROM executions e WHERE e.session_id = p.id
  ) x ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n,
           SUM(c.input_tokens) AS in_tok,
           SUM(c.output_tokens) AS out_tok,
           SUM(c.estimated_cost_micros) AS cost
    FROM agent_traces tr
    LEFT JOIN cost_usage c ON c.trace_id = tr.id
    WHERE tr.session_id = p.id
  ) t ON TRUE
  ORDER BY p.created_at DESC`;
}

function sessionFilterWhere(): string {
  return `
    WHERE ($1::text IS NULL OR mode = $1)
      AND ($2::text IS NULL OR status = $2)
      AND ($3::text IS NULL OR requirement ILIKE '%' || $3 || '%' OR output ILIKE '%' || $3 || '%')`;
}

export class SessionService {
  constructor(private readonly db: Database) {}

  async listSessions(filters: SessionFilters): Promise<{ items: SessionListItem[]; total: number }> {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0) || 0);
    const params: (string | number | null)[] = [
      filters.mode ?? null,
      filters.status ?? null,
      filters.q ?? null,
      limit,
      offset,
    ];

    const [pageRes, totalRes] = await Promise.all([
      this.db.query(sessionListPageSql(), params),
      this.db.query(
        `SELECT COUNT(*)::int AS total FROM sessions ${sessionFilterWhere()}`,
        params.slice(0, 3),
      ),
    ]);

    return {
      items: pageRes.rows.map((r) => ({
        id: r.id as string,
        requirement: r.requirement as string,
        mode: r.mode as string,
        role: r.role as string,
        status: r.status as string,
        createdAt: r.createdAt as string,
        updatedAt: r.updatedAt as string,
        executionCount: r.executionCount as number,
        traceCount: r.traceCount as number,
        inputTokens: r.inputTokens as number,
        outputTokens: r.outputTokens as number,
        costMicros: (r.costMicros as string) ?? "0",
      })),
      total: (totalRes.rows[0]?.total as number) ?? 0,
    };
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const sessionResult = await this.db.query(
      `SELECT id, user_id AS "userId", requirement, mode, role, status,
              output, error, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const row = sessionResult.rows[0] as pg.QueryResultRow | undefined;
    if (!row) return null;

    const [traces, executions] = await Promise.all([
      this.db.query(
        `SELECT t.id, t.name, t.status, t.execution_id AS "executionId",
                t.started_at AS "startedAt", t.ended_at AS "endedAt",
                EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000 AS "durationMs",
                COALESCE(e.mode, split_part(t.name, '.', 2)) AS mode,
                COALESCE(SUM(c.input_tokens), 0)::int AS "inputTokens",
                COALESCE(SUM(c.output_tokens), 0)::int AS "outputTokens",
                COALESCE(SUM(c.estimated_cost_micros), 0)::text AS "costMicros"
         FROM agent_traces t
         LEFT JOIN executions e ON e.id = t.execution_id
         LEFT JOIN cost_usage c ON c.trace_id = t.id
         WHERE t.session_id = $1
         GROUP BY t.id, e.mode
         ORDER BY t.started_at DESC`,
        [sessionId],
      ),
      this.db.query(
        `SELECT id, status, mode, created_at AS "createdAt", started_at AS "startedAt",
                completed_at AS "completedAt"
         FROM executions WHERE session_id = $1
         ORDER BY created_at DESC`,
        [sessionId],
      ),
    ]);

    const traceRows = traces.rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      mode: r.mode as string,
      status: r.status as string,
      executionId: (r.executionId as string | null) ?? null,
      startedAt: r.startedAt as string,
      endedAt: (r.endedAt as string | null) ?? null,
      durationMs: r.durationMs != null ? Number(r.durationMs) : null,
      inputTokens: r.inputTokens as number,
      outputTokens: r.outputTokens as number,
      costMicros: (r.costMicros as string) ?? "0",
    }));

    // execution → trace 关联在 TS 侧分组（trace 行已带 executionId）
    const byExecution = new Map<string, string[]>();
    for (const t of traceRows) {
      if (!t.executionId) continue;
      const ids = byExecution.get(t.executionId) ?? [];
      ids.push(t.id);
      byExecution.set(t.executionId, ids);
    }

    const totals = traceRows.reduce(
      (acc, t) => ({
        inputTokens: acc.inputTokens + t.inputTokens,
        outputTokens: acc.outputTokens + t.outputTokens,
        costMicrosNum: acc.costMicrosNum + Number(t.costMicros),
      }),
      { inputTokens: 0, outputTokens: 0, costMicrosNum: 0 },
    );

    return {
      session: {
        id: row.id as string,
        userId: row.userId as string,
        requirement: row.requirement as string,
        mode: row.mode as string,
        role: row.role as string,
        status: row.status as string,
        output: (row.output as string | null) ?? null,
        error: (row.error as string | null) ?? null,
        createdAt: row.createdAt as string,
        updatedAt: row.updatedAt as string,
      },
      traces: traceRows,
      executions: executions.rows.map((r) => ({
        id: r.id as string,
        status: r.status as string,
        mode: (r.mode as string | null) ?? null,
        createdAt: r.createdAt as string,
        startedAt: (r.startedAt as string | null) ?? null,
        completedAt: (r.completedAt as string | null) ?? null,
        traceIds: byExecution.get(r.id as string) ?? [],
      })),
      totals: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costMicros: String(totals.costMicrosNum),
      },
    };
  }
}
