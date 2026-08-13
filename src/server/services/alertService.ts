import type pg from "pg";
import type { Database } from "../db.js";

/**
 * 告警引擎：基于小时级指标表与实时查询的规则评估。
 *
 * 规则（全部可配阈值，数据源优先 obs_metrics.metric_hourly）：
 *   - error_rate   近 1h 错误率 ≥ threshold 且样本 ≥ minTraces
 *   - token_storm  单 execution token 消耗 ≥ 阈值（对应评测 EV-017/077 的 500k 预算临界）
 *   - cost_spike   24h 估算成本 ≥ 阈值（micros）
 *   - timeout_spike 1h 内 timed_out ≥ 阈值
 *   - hitl_stall   waiting_hitl 挂起超时（小时）
 *   - schema_drift 由契约复检外部触发（app.ts 调用 raise）
 *
 * 写入 obs_metrics.alerts（需要 obs_manager 连接；未配置则评估禁用）。
 * 去重：同一 (rule, key) 只保留一条 open 告警，重复触发仅更新 last_seen；
 * 条件恢复时自动 resolved。
 */

export interface AlertRecord {
  id: string;
  rule: string;
  severity: "warning" | "critical";
  status: "open" | "resolved";
  key: string;
  message: string;
  detail: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface AlertRuleThresholds {
  /** 错误率（0-1），默认 0.2 */
  errorRate: number;
  /** 错误率规则的最少样本数，默认 10 */
  errorRateMinTraces: number;
  /** 单 execution token 告警阈值，默认 400_000 */
  tokenStormThreshold: number;
  /** 24h 成本告警阈值（estimated_cost_micros），默认 5_000_000（≈$5） */
  costSpikeThresholdMicros: number;
  /** 1h 超时次数阈值，默认 3 */
  timeoutSpikeThreshold: number;
  /** HITL 挂起告警小时数，默认 24 */
  hitlStallHours: number;
}

export interface AlertServiceOptions {
  thresholds?: Partial<AlertRuleThresholds>;
  webhookUrl?: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

const DEFAULT_THRESHOLDS: AlertRuleThresholds = {
  errorRate: 0.2,
  errorRateMinTraces: 10,
  tokenStormThreshold: 400_000,
  costSpikeThresholdMicros: 5_000_000,
  timeoutSpikeThreshold: 3,
  hitlStallHours: 24,
};

const SCHEMA = "obs_metrics";

export class AlertService {
  private readonly thresholds: AlertRuleThresholds;

  constructor(
    private readonly db: Database,
    private readonly managerDb: Database | undefined,
    private readonly options: AlertServiceOptions = {},
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  }

  get enabled(): boolean {
    return this.managerDb != null;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }

  /** 触发或刷新一条告警（幂等 upsert；同 rule+key 已 open 时只更新 last_seen）。 */
  async raise(rule: string, severity: "warning" | "critical", key: string, message: string, detail: Record<string, unknown> = {}): Promise<void> {
    if (!this.managerDb) return;
    const id = `${rule}::${key}`.slice(0, 200);
    await this.managerDb.query(
      `INSERT INTO ${SCHEMA}.alerts (id, rule, severity, status, key, message, detail, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,'open',$4,$5,$6, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         last_seen_at = NOW(),
         detail = EXCLUDED.detail,
         message = EXCLUDED.message,
         severity = EXCLUDED.severity
       WHERE ${SCHEMA}.alerts.status = 'open'`,
      [id, rule, severity, key, message, JSON.stringify(detail)],
    );
    await this.notifyWebhook({ rule, severity, key, message, detail, status: "open" });
  }

  /** 手动解决一条告警（留痕）。 */
  async resolve(id: string, by: string): Promise<boolean> {
    if (!this.managerDb) return false;
    const result = await this.managerDb.query(
      `UPDATE ${SCHEMA}.alerts
          SET status = 'resolved', resolved_at = NOW(), resolved_by = $2
        WHERE id = $1 AND status = 'open'`,
      [id, by],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(limit = 100): Promise<AlertRecord[]> {
    const result = await this.db.query(
      `SELECT id, rule, severity, status, key, message, detail,
              first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
              resolved_at AS "resolvedAt"
         FROM ${SCHEMA}.alerts
        ORDER BY last_seen_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((r: pg.QueryResultRow) => ({
      id: String(r.id),
      rule: String(r.rule),
      severity: String(r.severity) as AlertRecord["severity"],
      status: String(r.status) as AlertRecord["status"],
      key: String(r.key),
      message: String(r.message),
      detail: (r.detail as Record<string, unknown>) ?? {},
      firstSeenAt: r.firstSeenAt as string,
      lastSeenAt: r.lastSeenAt as string,
      resolvedAt: (r.resolvedAt as string | null) ?? null,
    }));
  }

  /** 周期评估：读指标表 + 实时查询，触发/恢复告警。错误不抛出。 */
  async runScheduledEvaluation(): Promise<void> {
    if (!this.managerDb) return;
    try {
      await this.evaluateErrorRate();
      await this.evaluateTokenStorm();
      await this.evaluateCostSpike();
      await this.evaluateTimeoutSpike();
      await this.evaluateHitlStall();
    } catch (err) {
      this.log("error", `[alerts] evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async evaluateErrorRate(): Promise<void> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'error')::int AS error_n
         FROM agent_traces
        WHERE started_at >= now() - interval '1 hour'`,
    );
    const n = Number(result.rows[0]?.n ?? 0);
    const errorN = Number(result.rows[0]?.error_n ?? 0);
    if (n < this.thresholds.errorRateMinTraces) return;
    const rate = n > 0 ? errorN / n : 0;
    if (rate >= this.thresholds.errorRate) {
      await this.raise(
        "error_rate",
        "critical",
        "last-1h",
        `近 1 小时错误率 ${(rate * 100).toFixed(1)}%（${errorN}/${n}）超过阈值 ${(this.thresholds.errorRate * 100).toFixed(0)}%`,
        { n, errorN, rate, window: "1h" },
      );
    } else {
      await this.autoResolve("error_rate", "last-1h");
    }
  }

  private async evaluateTokenStorm(): Promise<void> {
    const result = await this.db.query(
      `SELECT e.id AS execution_id,
              COALESCE(SUM(c.input_tokens), 0) + COALESCE(SUM(c.output_tokens), 0)::bigint AS tokens
         FROM executions e
         LEFT JOIN cost_usage c ON c.trace_id IN (
           SELECT id FROM agent_traces WHERE execution_id = e.id
         )
        WHERE e.started_at >= now() - interval '24 hours'
        GROUP BY e.id
       HAVING COALESCE(SUM(c.input_tokens), 0) + COALESCE(SUM(c.output_tokens), 0) >= $1
        LIMIT 10`,
      [this.thresholds.tokenStormThreshold],
    );
    for (const row of result.rows) {
      await this.raise(
        "token_storm",
        "warning",
        String(row.execution_id),
        `执行 ${row.execution_id} token 消耗 ${row.tokens} 超过阈值 ${this.thresholds.tokenStormThreshold}`,
        { executionId: row.execution_id, tokens: Number(row.tokens) },
      );
    }
    // 恢复检查：只自动解决不再超标的执行
    const open = await this.db.query(
      `SELECT id, key FROM ${SCHEMA}.alerts WHERE rule = 'token_storm' AND status = 'open'`,
    );
    for (const row of open.rows) {
      const execId = String(row.key);
      const still = await this.db.query(
        `SELECT 1 FROM executions e
          LEFT JOIN cost_usage c ON c.trace_id IN (SELECT id FROM agent_traces WHERE execution_id = e.id)
         WHERE e.id = $1
         GROUP BY e.id
        HAVING COALESCE(SUM(c.input_tokens),0) + COALESCE(SUM(c.output_tokens),0) >= $2`,
        [execId, this.thresholds.tokenStormThreshold],
      );
      if (still.rowCount === 0) {
        await this.managerDb?.query(
          `UPDATE ${SCHEMA}.alerts SET status='resolved', resolved_at=NOW(), resolved_by='system:auto' WHERE id=$1 AND status='open'`,
          [String(row.id)],
        );
      }
    }
  }

  private async evaluateCostSpike(): Promise<void> {
    const result = await this.db.query(
      `SELECT COALESCE(SUM(estimated_cost_micros), 0)::numeric AS cost_micros
         FROM cost_usage
        WHERE created_at >= now() - interval '24 hours'`,
    );
    const cost = Number(result.rows[0]?.cost_micros ?? 0);
    if (cost >= this.thresholds.costSpikeThresholdMicros) {
      await this.raise(
        "cost_spike",
        "warning",
        "last-24h",
        `24 小时估算成本 $${(cost / 1_000_000).toFixed(2)} 超过阈值 $${(this.thresholds.costSpikeThresholdMicros / 1_000_000).toFixed(2)}`,
        { costMicros: cost, window: "24h" },
      );
    } else {
      await this.autoResolve("cost_spike", "last-24h");
    }
  }

  private async evaluateTimeoutSpike(): Promise<void> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS n
         FROM executions
        WHERE status = 'timed_out' AND started_at >= now() - interval '1 hour'`,
    );
    const n = Number(result.rows[0]?.n ?? 0);
    if (n >= this.thresholds.timeoutSpikeThreshold) {
      await this.raise(
        "timeout_spike",
        "warning",
        "last-1h",
        `近 1 小时 ${n} 次执行超时（阈值 ${this.thresholds.timeoutSpikeThreshold}）`,
        { n, window: "1h" },
      );
    } else {
      await this.autoResolve("timeout_spike", "last-1h");
    }
  }

  private async evaluateHitlStall(): Promise<void> {
    const result = await this.db.query(
      `SELECT id, updated_at
         FROM executions
        WHERE status = 'waiting_hitl'
          AND updated_at < now() - make_interval(hours => $1)
        ORDER BY updated_at
        LIMIT 10`,
      [this.thresholds.hitlStallHours],
    );
    for (const row of result.rows) {
      await this.raise(
        "hitl_stall",
        "warning",
        String(row.id),
        `执行 ${row.id} 等待人工审阅超过 ${this.thresholds.hitlStallHours} 小时`,
        { executionId: String(row.id), updatedAt: row.updated_at },
      );
    }
    // 挂起恢复（被审批）后自动解决
    const open = await this.db.query(
      `SELECT id, key FROM ${SCHEMA}.alerts WHERE rule = 'hitl_stall' AND status = 'open'`,
    );
    for (const row of open.rows) {
      const still = await this.db.query(
        `SELECT 1 FROM executions WHERE id = $1 AND status = 'waiting_hitl'`,
        [String(row.key)],
      );
      if (still.rowCount === 0) {
        await this.managerDb?.query(
          `UPDATE ${SCHEMA}.alerts SET status='resolved', resolved_at=NOW(), resolved_by='system:auto' WHERE id=$1 AND status='open'`,
          [String(row.id)],
        );
      }
    }
  }

  /** 条件恢复：不再满足阈值时自动关闭（schema_drift 除外——由人工确认）。 */
  private async autoResolve(rule: string, key: string): Promise<void> {
    if (!this.managerDb) return;
    await this.managerDb.query(
      `UPDATE ${SCHEMA}.alerts
          SET status = 'resolved', resolved_at = NOW(), resolved_by = 'system:auto'
        WHERE rule = $1 AND key = $2 AND status = 'open'`,
      [rule, key],
    );
  }

  /** schema 漂移告警（由契约复检调用；只触发不自动恢复）。 */
  async raiseSchemaDrift(detail: string): Promise<void> {
    await this.raise(
      "schema_drift",
      "critical",
      "contract",
      `共享库 schema 契约漂移：${detail}`,
      { detail },
    );
  }

  private async notifyWebhook(payload: Record<string, unknown>): Promise<void> {
    const url = this.options.webhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "agent-observe", ...payload }),
      });
    } catch (err) {
      this.log("warn", `[alerts] webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
