import type pg from "pg";
import type { Database } from "../db.js";

/**
 * 小时级指标聚合（观测台自有表，独立 schema obs_metrics）。
 *
 * 与 design-agent 共享表严格分界：本服务只读共享表（agent_traces /
 * executions / cost_usage），把聚合结果写入 obs_metrics.metric_hourly
 * （需要 obs_manager 连接，未配置则指标写入禁用，查询不受影响）。
 *
 * 表由 scripts/create-metrics-schema.mjs 幂等创建；obs_reader 仅授权 SELECT，
 * 供趋势查询使用。
 */

export interface TrendPoint {
  bucket: string;
  mode: string;
  status: string;
  n: number;
  errorN: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: string;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  maxDurationMs: number | null;
}

export interface MetricsServiceOptions {
  retentionDays: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

const METRICS_SCHEMA = "obs_metrics";
const METRICS_TABLE = "metric_hourly";

export class MetricsService {
  constructor(
    private readonly db: Database,
    private readonly managerDb: Database | undefined,
    private readonly options: MetricsServiceOptions,
  ) {}

  /** 指标写入是否可用：需要 obs_manager 连接（INSERT/UPDATE 权限）。 */
  get enabled(): boolean {
    return this.managerDb != null;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }

  /**
   * 聚合一个小时的 trace 数据并写入指标表（幂等 upsert）。
   * @param hourStartIso 该小时起点（UTC ISO）；缺省为上一整小时。
   */
  async aggregateHour(hourStartIso?: string): Promise<{ written: boolean; reason?: string }> {
    if (!this.managerDb) {
      return { written: false, reason: "metrics disabled: OBS_MANAGER_DATABASE_URL not configured" };
    }
    const start = hourStartIso ?? previousHourStart();
    const end = new Date(new Date(start).getTime() + 3_600_000).toISOString();

    // 1) 按 trace 汇总 cost（cost_usage 一对多，先压平避免重复行膨胀）
    const aggregated = await this.managerDb.query(
      `WITH trace_cost AS (
         SELECT trace_id,
                COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
                COALESCE(SUM(estimated_cost_micros), 0)::numeric AS cost_micros
           FROM cost_usage
          WHERE trace_id IN (SELECT id FROM agent_traces WHERE started_at >= $1 AND started_at < $2)
          GROUP BY trace_id
       ),
       base AS (
         SELECT date_trunc('hour', t.started_at) AS bucket_hour,
                COALESCE(e.mode, split_part(t.name, '.', 2), 'unknown') AS mode,
                COALESCE(t.status, 'unset') AS status,
                EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000 AS duration_ms,
                COALESCE(tc.input_tokens, 0) AS input_tokens,
                COALESCE(tc.output_tokens, 0) AS output_tokens,
                COALESCE(tc.cost_micros, 0) AS cost_micros
           FROM agent_traces t
           LEFT JOIN executions e ON e.id = t.execution_id
           LEFT JOIN trace_cost tc ON tc.trace_id = t.id
          WHERE t.started_at >= $1 AND t.started_at < $2
       )
       SELECT bucket_hour, mode, status,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'error')::int AS error_n,
              SUM(input_tokens)::bigint AS input_tokens,
              SUM(output_tokens)::bigint AS output_tokens,
              SUM(cost_micros)::numeric AS cost_micros,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_duration_ms,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms,
              MAX(duration_ms) AS max_duration_ms
         FROM base
        GROUP BY bucket_hour, mode, status`,
      [start, end],
    );

    let written = 0;
    for (const row of aggregated.rows) {
      await this.managerDb.query(
        `INSERT INTO ${METRICS_SCHEMA}.${METRICS_TABLE}
           (bucket_hour, mode, status, n, error_n, input_tokens, output_tokens,
            cost_micros, p50_duration_ms, p95_duration_ms, max_duration_ms, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
         ON CONFLICT (bucket_hour, mode, status) DO UPDATE SET
           n = EXCLUDED.n,
           error_n = EXCLUDED.error_n,
           input_tokens = EXCLUDED.input_tokens,
           output_tokens = EXCLUDED.output_tokens,
           cost_micros = EXCLUDED.cost_micros,
           p50_duration_ms = EXCLUDED.p50_duration_ms,
           p95_duration_ms = EXCLUDED.p95_duration_ms,
           max_duration_ms = EXCLUDED.max_duration_ms,
           updated_at = NOW()`,
        [
          (row.bucket_hour as Date).toISOString(),
          String(row.mode ?? "unknown"),
          String(row.status ?? "unset"),
          Number(row.n ?? 0),
          Number(row.error_n ?? 0),
          Number(row.input_tokens ?? 0),
          Number(row.output_tokens ?? 0),
          String(row.cost_micros ?? 0),
          row.p50_duration_ms == null ? null : Number(row.p50_duration_ms),
          row.p95_duration_ms == null ? null : Number(row.p95_duration_ms),
          row.max_duration_ms == null ? null : Number(row.max_duration_ms),
        ],
      );
      written += 1;
    }

    if (this.options.retentionDays > 0) {
      await this.prune(this.options.retentionDays);
    }
    return { written: written > 0 };
  }

  /** 清理早于保留期的指标桶（与 trace TTL 对齐）。 */
  async prune(days: number): Promise<number> {
    if (!this.managerDb) return 0;
    const result = await this.managerDb.query(
      `DELETE FROM ${METRICS_SCHEMA}.${METRICS_TABLE}
        WHERE bucket_hour < now() - make_interval(days => $1)`,
      [days],
    );
    return result.rowCount ?? 0;
  }

  /** 读取近 N 天指标（只读连接即可，obs_reader 已授权 SELECT）。 */
  async getTrend(days: number): Promise<TrendPoint[]> {
    const result = await this.db.query(
      `SELECT to_char(bucket_hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00') AS bucket,
              mode, status, n, error_n,
              input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              cost_micros AS "costMicros",
              p50_duration_ms AS "p50DurationMs",
              p95_duration_ms AS "p95DurationMs",
              max_duration_ms AS "maxDurationMs"
         FROM ${METRICS_SCHEMA}.${METRICS_TABLE}
        WHERE bucket_hour >= now() - make_interval(days => $1)
        ORDER BY bucket_hour`,
      [days],
    );
    return result.rows.map((r: pg.QueryResultRow) => ({
      bucket: String(r.bucket ?? ""),
      mode: String(r.mode ?? "unknown"),
      status: String(r.status ?? "unset"),
      n: Number(r.n ?? 0),
      errorN: Number(r.error_n ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      costMicros: String(r.costMicros ?? 0),
      p50DurationMs: r.p50DurationMs == null ? null : Number(r.p50DurationMs),
      p95DurationMs: r.p95DurationMs == null ? null : Number(r.p95DurationMs),
      maxDurationMs: r.maxDurationMs == null ? null : Number(r.maxDurationMs),
    }));
  }

  /** 周期任务：聚合上一整小时 + 清理过期桶，错误不抛出（守护进程语义）。 */
  async runScheduledAggregate(): Promise<void> {
    try {
      const result = await this.aggregateHour();
      this.log(
        "info",
        result.written
          ? `[metrics] aggregated ${result.reason ?? "previous hour"}`
          : `[metrics] aggregate skipped: ${result.reason ?? "no rows"}`,
      );
    } catch (err) {
      this.log(
        "error",
        `[metrics] aggregate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 上一整小时起点（UTC ISO），避免聚合未完成的小时。 */
export function previousHourStart(now: Date = new Date()): string {
  const d = new Date(now.getTime() - 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
