import type pg from "pg";
import type { Database } from "../db.js";

/**
 * 知识飞轮回流调度器（方案 03 Phase 3）：把观测台聚合出的运行信号
 * （错误率 / 超时 / 工具反复失败 / 成本异常）转成 knowledge-hub 的
 * Agent 反馈（kb_report_gap / kb_report_bad_hit），驱动既有自进化管线。
 *
 * 护栏：
 * - 幂等：同 (rule, 信号键, 小时窗口) 只在 dedupe 窗口内上报一次（flywheel_reports 表）
 * - dry-run：只打印将上报的信号，不上报不落库（灰度一周后关）
 * - 上报失败仅告警，绝不中断评估；未配置 khUrl/khToken 时整体禁用
 * - R5（低反馈率 → stale）需要 knowledge-hub 消费侧指标，本实现留待指标就绪
 */

export interface FlywheelThresholds {
  errorRate: number;
  minErrors: number;
  minTimeouts: number;
  minToolErrors: number;
  costThresholdMicros: number;
  dedupeWindowHours: number;
}

export interface FlywheelReporterOptions {
  khUrl?: string;
  khToken?: string;
  dryRun: boolean;
  projectId: string;
  thresholds: FlywheelThresholds;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface FlywheelSignal {
  rule: "error_rate" | "timeout_spike" | "tool_error" | "cost_spike";
  toolName: "kb_report_gap" | "kb_report_bad_hit";
  reportKey: string;
  payload: Record<string, unknown>;
  sourceTraceIds: string[];
}

export interface FlywheelReportRow {
  reportKey: string;
  rule: string;
  reportedAt: string;
  detail: Record<string, unknown>;
}

const SCHEMA = "obs_metrics";
const TABLE = "flywheel_reports";

/** 小时窗口键（UTC），用于幂等去重。 */
function windowKey(now: Date = new Date()): string {
  const d = new Date(now.getTime() - 60 * 1000); // 上一分钟归属，避免边界抖动
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13);
}

export class FlywheelReporter {
  constructor(
    private readonly db: Database,
    private readonly managerDb: Database | undefined,
    private readonly options: FlywheelReporterOptions,
  ) {}

  /** 回流是否启用：需要 manager 连接（幂等表）+ knowledge-hub 地址与凭据。 */
  get enabled(): boolean {
    return this.managerDb != null && Boolean(this.options.khUrl && this.options.khToken);
  }

  get dryRun(): boolean {
    return this.options.dryRun;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }

  /** 周期入口：收集信号 → 幂等过滤 → 上报。错误不抛出（守护进程语义）。 */
  async runScheduledEvaluation(): Promise<{ collected: number; reported: number; skipped: number }> {
    if (!this.enabled) {
      this.log("warn", "[flywheel] disabled: missing OBS_MANAGER_DATABASE_URL or OBS_FLYWHEEL_KH_URL/KH_TOKEN");
      return { collected: 0, reported: 0, skipped: 0 };
    }
    try {
      const signals = await this.collectSignals();
      let reported = 0;
      let skipped = 0;
      for (const signal of signals) {
        if (await this.isReported(signal.reportKey)) {
          skipped += 1;
          continue;
        }
        if (this.options.dryRun) {
          this.log(
            "info",
            `[flywheel][dry-run] would report ${signal.rule} → ${signal.toolName} key=${signal.reportKey} traces=${signal.sourceTraceIds.join(",")} reason=${String(signal.payload.reason ?? "")}`,
          );
          continue;
        }
        const ok = await this.report(signal);
        if (ok) {
          await this.markReported(signal);
          reported += 1;
        }
      }
      this.log(
        "info",
        `[flywheel] evaluation done: ${signals.length} signals, ${reported} reported, ${skipped} deduped (dryRun=${this.options.dryRun})`,
      );
      return { collected: signals.length, reported, skipped };
    } catch (err) {
      this.log("error", `[flywheel] evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
      return { collected: 0, reported: 0, skipped: 0 };
    }
  }

  /** 近 N 条已上报信号（供观测台"信号预览页"）。 */
  async recentReports(limit = 50): Promise<FlywheelReportRow[]> {
    const result = await this.db.query(
      `SELECT report_key AS "reportKey", rule, reported_at AS "reportedAt", detail
         FROM ${SCHEMA}.${TABLE}
        ORDER BY reported_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map((r: pg.QueryResultRow) => ({
      reportKey: String(r.reportKey),
      rule: String(r.rule),
      reportedAt: r.reportedAt as string,
      detail: (r.detail as Record<string, unknown>) ?? {},
    }));
  }

  // ─── 信号收集 ──────────────────────────────────────────────────────

  private async collectSignals(): Promise<FlywheelSignal[]> {
    const signals: FlywheelSignal[] = [];
    const wk = windowKey();
    const t = this.options.thresholds;

    // R1 错误率：同需求（requirement 哈希）失败数 ≥ minErrors 且错误率 ≥ errorRate
    const errorResult = await this.db.query(
      `SELECT md5(COALESCE(request_payload->>'requirement', '')) AS req_hash,
              COALESCE(request_payload->>'requirement', '') AS requirement,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS error_n,
              MAX(id) AS latest_execution_id,
              MAX(started_at) AS latest_started_at
         FROM executions
        WHERE started_at >= now() - interval '1 hour'
        GROUP BY 1, 2
       HAVING COUNT(*) FILTER (WHERE status = 'failed') >= $1
          AND COUNT(*) FILTER (WHERE status = 'failed')::float / COUNT(*) >= $2
        ORDER BY error_n DESC
        LIMIT 5`,
      [t.minErrors, t.errorRate],
    );
    for (const row of errorResult.rows) {
      const requirement = String(row.requirement ?? "").slice(0, 500);
      if (!requirement.trim()) continue;
      signals.push({
        rule: "error_rate",
        toolName: "kb_report_gap",
        reportKey: `error_rate::${String(row.req_hash ?? "")}::${wk}`,
        payload: {
          query: requirement,
          reason: `agent-observe: 同需求 1h 内 ${row.error_n}/${row.n} 次执行失败（错误率 ≥ ${(t.errorRate * 100).toFixed(0)}%）`,
          note: "由观测台回流调度器自动上报（来源 trace 见 sourceTraceIds）",
        },
        sourceTraceIds: [String(row.latest_execution_id ?? "")].filter(Boolean),
      });
    }

    // R2 超时：1h 内 timed_out ≥ minTimeouts
    const timeoutResult = await this.db.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(MAX(request_payload->>'requirement'), '') AS requirement,
              MAX(id) AS latest_execution_id
         FROM executions
        WHERE status = 'timed_out' AND started_at >= now() - interval '1 hour'`,
    );
    const timeoutN = Number(timeoutResult.rows[0]?.n ?? 0);
    if (timeoutN >= t.minTimeouts) {
      signals.push({
        rule: "timeout_spike",
        toolName: "kb_report_gap",
        reportKey: `timeout_spike::${wk}`,
        payload: {
          query: String(timeoutResult.rows[0]?.requirement ?? "").slice(0, 500) || undefined,
          reason: `agent-observe: 1h 内 ${timeoutN} 次执行超时`,
          note: "由观测台回流调度器自动上报；建议核查该需求的知识覆盖与工具链。",
        },
        sourceTraceIds: [String(timeoutResult.rows[0]?.latest_execution_id ?? "")].filter(Boolean),
      });
    }

    // R3 工具反复失败：1h 内同工具 span 错误 ≥ minToolErrors
    const toolResult = await this.db.query(
      `SELECT attributes->>'toolName' AS tool_name,
              COUNT(*)::int AS n,
              MAX(trace_id) AS latest_trace_id
         FROM agent_spans
        WHERE status = 'error'
          AND attributes ? 'toolName'
          AND started_at >= now() - interval '1 hour'
        GROUP BY 1
       HAVING COUNT(*) >= $1
        ORDER BY n DESC
        LIMIT 5`,
      [t.minToolErrors],
    );
    for (const row of toolResult.rows) {
      const toolName = String(row.tool_name ?? "");
      if (!toolName) continue;
      signals.push({
        rule: "tool_error",
        toolName: "kb_report_bad_hit",
        reportKey: `tool_error::${toolName}::${wk}`,
        payload: {
          reason: `agent-observe: 1h 内工具 ${toolName} 失败 ${row.n} 次（观测台自动上报）`,
          note: "工具反复失败可能意味着知识不足导致 Agent 反复尝试；请核查相关页面/配表。",
        },
        sourceTraceIds: [String(row.latest_trace_id ?? "")].filter(Boolean),
      });
    }

    // R4 成本异常：24h 成本 ≥ 阈值 → 归因到最高成本 execution
    const costResult = await this.db.query(
      `WITH cost_total AS (
         SELECT COALESCE(SUM(estimated_cost_micros), 0)::numeric AS total_micros
           FROM cost_usage
          WHERE created_at >= now() - interval '24 hours'
       ),
       top AS (
         SELECT e.id AS execution_id, e.request_payload,
                SUM(c.estimated_cost_micros)::numeric AS exec_micros
           FROM executions e
           LEFT JOIN agent_traces t ON t.execution_id = e.id
           LEFT JOIN cost_usage c ON c.trace_id = t.id
          WHERE e.started_at >= now() - interval '24 hours'
          GROUP BY e.id, e.request_payload
          ORDER BY exec_micros DESC NULLS LAST
          LIMIT 1
       )
       SELECT ct.total_micros, top.execution_id, top.request_payload, top.exec_micros
         FROM cost_total ct CROSS JOIN top`,
    );
    const totalMicros = Number(costResult.rows[0]?.total_micros ?? 0);
    if (totalMicros >= t.costThresholdMicros) {
      signals.push({
        rule: "cost_spike",
        toolName: "kb_report_gap",
        reportKey: `cost_spike::${wk}`,
        payload: {
          query: String((costResult.rows[0]?.request_payload as Record<string, unknown> | undefined)?.requirement ?? "").slice(0, 500) || undefined,
          reason: `agent-observe: 24h 估算成本 $${(totalMicros / 1_000_000).toFixed(2)} 超过阈值 $${(t.costThresholdMicros / 1_000_000).toFixed(2)}（最高单执行 $${(Number(costResult.rows[0]?.exec_micros ?? 0) / 1_000_000).toFixed(2)}）`,
          note: "成本异常常源于检索不足导致的反复尝试；建议核查知识覆盖与工具调用链。",
        },
        sourceTraceIds: [String(costResult.rows[0]?.execution_id ?? "")].filter(Boolean),
      });
    }

    return signals;
  }

  // ─── 幂等与上报 ────────────────────────────────────────────────────

  private async isReported(reportKey: string): Promise<boolean> {
    if (!this.managerDb) return true;
    const hours = this.options.thresholds.dedupeWindowHours;
    const result = await this.managerDb.query(
      `SELECT 1 FROM ${SCHEMA}.${TABLE}
        WHERE report_key = $1
          AND reported_at >= now() - make_interval(hours => $2)`,
      [reportKey, hours],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async markReported(signal: FlywheelSignal): Promise<void> {
    if (!this.managerDb) return;
    await this.managerDb.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (report_key, rule, reported_at, detail)
       VALUES ($1, $2, NOW(), $3)`,
      [signal.reportKey, signal.rule, JSON.stringify({ toolName: signal.toolName, sourceTraceIds: signal.sourceTraceIds, payload: signal.payload })],
    );
  }

  /** 上报到 knowledge-hub /api/mcp/query（service account JWT）。 */
  private async report(signal: FlywheelSignal): Promise<boolean> {
    const url = `${this.options.khUrl!.replace(/\/+$/u, "")}/api/mcp/query`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.khToken}`,
        },
        body: JSON.stringify({
          toolName: signal.toolName,
          payload: {
            ...signal.payload,
            projectId: this.options.projectId,
            sessionId: "obs-flywheel",
            agentRole: "obs-flywheel",
          },
        }),
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        this.log("warn", `[flywheel] report failed (${response.status}): ${text}`);
        return false;
      }
      return true;
    } catch (err) {
      this.log("warn", `[flywheel] report request failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
