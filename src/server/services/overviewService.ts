import type pg from "pg";
import type { Database } from "../db.js";

export interface OverviewData {
  /** 统计窗口（小时） */
  windowHours: number;
  tracesTotal: number;
  tracesOk: number;
  tracesError: number;
  errorRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  maxDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  statusBreakdown: { status: string; n: number }[];
  modeBreakdown: { mode: string; n: number; errors: number }[];
  /** 24h 逐小时桶（含空桶） */
  trend: { bucket: string; n: number; errors: number }[];
  recentErrors: { id: string; name: string; startedAt: string; durationMs: number | null }[];
}

const WINDOW_HOURS = 24;

export class OverviewService {
  constructor(private readonly db: Database) {}

  async getOverview(): Promise<OverviewData> {
    const [totals, status, modes, tokens, trend, recent] = await Promise.all([
      this.db.query(
        `SELECT COUNT(*)::int AS "tracesTotal",
                COUNT(*) FILTER (WHERE status = 'ok')::int AS "tracesOk",
                COUNT(*) FILTER (WHERE status = 'error')::int AS "tracesError",
                COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::int, 0) AS "avgDurationMs",
                COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::int, 0) AS "p50DurationMs",
                COALESCE(MAX(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::int, 0) AS "maxDurationMs"
         FROM agent_traces WHERE created_at >= now() - interval '${WINDOW_HOURS} hours'`,
      ),
      this.db.query(
        `SELECT status, COUNT(*)::int AS n
         FROM agent_traces WHERE created_at >= now() - interval '${WINDOW_HOURS} hours'
         GROUP BY status ORDER BY n DESC`,
      ),
      this.db.query(
        `SELECT split_part(name, '.', 2) AS mode,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE status = 'error')::int AS errors
         FROM agent_traces
         WHERE name LIKE 'director.%' AND created_at >= now() - interval '${WINDOW_HOURS} hours'
         GROUP BY 1 ORDER BY n DESC`,
      ),
      this.db.query(
        `SELECT COALESCE(SUM(input_tokens), 0)::int AS "inputTokens",
                COALESCE(SUM(output_tokens), 0)::int AS "outputTokens"
         FROM cost_usage WHERE created_at >= now() - interval '${WINDOW_HOURS} hours'`,
      ),
      this.db.query(
        `SELECT to_char(date_trunc('hour', started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00') AS bucket,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE status = 'error')::int AS errors
         FROM agent_traces
         WHERE started_at >= now() - interval '${WINDOW_HOURS} hours'
         GROUP BY 1 ORDER BY 1`,
      ),
      this.db.query(
        `SELECT id, name, started_at AS "startedAt",
                EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000 AS "durationMs"
         FROM agent_traces WHERE status = 'error'
         ORDER BY started_at DESC LIMIT 20`,
      ),
    ]);

    const totalsRow = totals.rows[0] as pg.QueryResultRow;
    const tokenRow = tokens.rows[0] as pg.QueryResultRow;
    const total = Number(totalsRow?.tracesTotal ?? 0);
    const error = Number(totalsRow?.tracesError ?? 0);

    // 补齐 24h 内缺失的小时桶（零填充），保证前端条图连续
    const buckets = new Map<string, { n: number; errors: number }>();
    for (const r of trend.rows) {
      buckets.set(r.bucket as string, { n: Number(r.n ?? 0), errors: Number(r.errors ?? 0) });
    }
    const trendFilled: OverviewData["trend"] = [];
    const now = new Date();
    for (let i = WINDOW_HOURS - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3_600_000);
      d.setMinutes(0, 0, 0);
      const key = d.toISOString().slice(0, 13) + ":00";
      const row = buckets.get(key) ?? { n: 0, errors: 0 };
      trendFilled.push({ bucket: key, ...row });
    }

    return {
      windowHours: WINDOW_HOURS,
      tracesTotal: total,
      tracesOk: Number(totalsRow?.tracesOk ?? 0),
      tracesError: error,
      errorRate: total > 0 ? Math.round((error / total) * 1000) / 10 : 0,
      avgDurationMs: Number(totalsRow?.avgDurationMs ?? 0),
      p50DurationMs: Number(totalsRow?.p50DurationMs ?? 0),
      maxDurationMs: Number(totalsRow?.maxDurationMs ?? 0),
      inputTokens: Number(tokenRow?.inputTokens ?? 0),
      outputTokens: Number(tokenRow?.outputTokens ?? 0),
      statusBreakdown: status.rows.map((r) => ({
        status: r.status as string,
        n: Number(r.n ?? 0),
      })),
      modeBreakdown: modes.rows.map((r) => ({
        mode: (r.mode as string | null) ?? "other",
        n: Number(r.n ?? 0),
        errors: Number(r.errors ?? 0),
      })),
      trend: trendFilled,
      recentErrors: recent.rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        startedAt: r.startedAt as string,
        durationMs: r.durationMs != null ? Number(r.durationMs) : null,
      })),
    };
  }
}
