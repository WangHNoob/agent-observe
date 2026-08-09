import type pg from "pg";
import type { Database } from "../db.js";

// ─── 类型 ──────────────────────────────────────────────────────────────

export interface TraceFilters {
  userId?: string;
  sessionId?: string;
  executionId?: string;
  /** trace 名称模糊匹配（如 director.query） */
  name?: string;
  /** 模式精确匹配（query/design/table），等价 name = 'director.<mode>' */
  mode?: string;
  status?: "ok" | "error" | "unset";
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface TraceListItem {
  id: string;
  name: string;
  mode: string | null;
  status: string;
  userId: string;
  sessionId: string;
  executionId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costRows: number;
}

export interface SpanRow {
  id: string;
  parentSpanId: string | null;
  name: string;
  phase: string | null;
  kind: string;
  status: string;
  attributes: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface CostRow {
  agentName: string | null;
  modelName: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: string;
  createdAt: string;
}

export interface AuditRow {
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface TraceDetail {
  trace: {
    id: string;
    userId: string;
    traceSessionId: string;
    sessionId: string;
    executionId: string | null;
    name: string;
    status: string;
    attributes: Record<string, unknown>;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    createdAt: string;
  };
  spans: SpanRow[];
  costRows: CostRow[];
  auditRows: AuditRow[];
}

// ─── 服务 ──────────────────────────────────────────────────────────────

function traceFilterClause(): string {
  return `
  WHERE ($1::text IS NULL OR t.user_id = $1)
    AND ($2::text IS NULL OR t.session_id = $2)
    AND ($3::text IS NULL OR t.execution_id = $3)
    AND ($4::text IS NULL OR t.name ILIKE '%' || $4 || '%')
    AND ($5::text IS NULL OR t.name = 'director.' || $5)
    AND ($6::text IS NULL OR t.status = $6)
    AND ($7::timestamptz IS NULL OR t.started_at >= $7)
    AND ($8::timestamptz IS NULL OR t.started_at <= $8)`;
}

/** 先按筛选分页取页内 trace，再 JOIN cost 聚合——避免对全量匹配行做 GROUP BY。 */
function traceListPageSql(): string {
  return `
  WITH page AS (
    SELECT t.id, t.name, t.status, t.user_id, t.session_id, t.execution_id,
           t.started_at, t.ended_at,
           EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000 AS duration_ms,
           split_part(t.name, '.', 2) AS mode
    FROM agent_traces t
    ${traceFilterClause()}
    ORDER BY t.started_at DESC
    LIMIT $9 OFFSET $10
  )
  SELECT p.id, p.name, p.status, p.user_id AS "userId",
         p.session_id AS "sessionId", p.execution_id AS "executionId",
         p.started_at AS "startedAt", p.ended_at AS "endedAt",
         p.duration_ms AS "durationMs", p.mode,
         COALESCE(SUM(c.input_tokens), 0)::int AS "inputTokens",
         COALESCE(SUM(c.output_tokens), 0)::int AS "outputTokens",
         COUNT(c.id)::int AS "costRows"
  FROM page p
  LEFT JOIN cost_usage c ON c.trace_id = p.id
  GROUP BY p.id, p.name, p.status, p.user_id, p.session_id, p.execution_id,
           p.started_at, p.ended_at, p.duration_ms, p.mode
  ORDER BY p.started_at DESC`;
}

function traceFilterParams(f: TraceFilters): (string | number | null)[] {
  return [
    f.userId ?? null,
    f.sessionId ?? null,
    f.executionId ?? null,
    f.name ?? null,
    f.mode ?? null,
    f.status ?? null,
    f.from ?? null,
    f.to ?? null,
  ];
}

export class ManagementDisabledError extends Error {
  constructor() {
    super("Trace management disabled: OBS_MANAGER_DATABASE_URL not configured");
    this.name = "ManagementDisabledError";
  }
}

export class TraceService {
  constructor(
    private readonly db: Database,
    private readonly managerDb?: Database,
  ) {}

  /** 管理功能（删除/清理）是否可用：依赖 obs_manager 连接 */
  get managementEnabled(): boolean {
    return this.managerDb != null;
  }

  private requireManager(): Database {
    if (!this.managerDb) throw new ManagementDisabledError();
    return this.managerDb;
  }

  async listTraces(
    filters: TraceFilters,
  ): Promise<{ items: TraceListItem[]; total: number }> {
    const rawLimit = filters.limit ?? 50;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50;
    const rawOffset = filters.offset ?? 0;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
    const params = traceFilterParams(filters);

    const [items, count] = await Promise.all([
      this.db.query<pg.QueryResultRow>(traceListPageSql(), [...params, limit, offset]),
      this.db.query<pg.QueryResultRow>(
        `SELECT COUNT(*)::int AS total FROM agent_traces t${traceFilterClause()}`,
        params,
      ),
    ]);

    return {
      items: items.rows.map(rowToListItem),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async getTraceDetail(traceId: string): Promise<TraceDetail | null> {
    const traceResult = await this.db.query(
      `SELECT id, user_id AS "userId", trace_session_id AS "traceSessionId",
              session_id AS "sessionId", execution_id AS "executionId",
              name, status, attributes, started_at AS "startedAt",
              ended_at AS "endedAt",
              EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000 AS "durationMs",
              created_at AS "createdAt"
       FROM agent_traces WHERE id = $1`,
      [traceId],
    );
    const traceRow = traceResult.rows[0] as pg.QueryResultRow | undefined;
    if (!traceRow) return null;

    const [spans, costRows, auditRows] = await Promise.all([
      this.db.query(
        `SELECT id, parent_span_id AS "parentSpanId", name, phase, kind, status,
                attributes, started_at AS "startedAt", ended_at AS "endedAt",
                EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000 AS "durationMs"
         FROM agent_spans WHERE trace_id = $1
         ORDER BY started_at, created_at`,
        [traceId],
      ),
      this.db.query(
        `SELECT agent_name AS "agentName", model_name AS "modelName",
                input_tokens AS "inputTokens", output_tokens AS "outputTokens",
                estimated_cost_micros AS "estimatedCostMicros", created_at AS "createdAt"
         FROM cost_usage WHERE trace_id = $1 ORDER BY created_at`,
        [traceId],
      ),
      this.db.query(
        `SELECT action, resource_type AS "resourceType", resource_id AS "resourceId",
                outcome, detail, created_at AS "createdAt"
         FROM audit_logs WHERE trace_id = $1 ORDER BY created_at`,
        [traceId],
      ),
    ]);

    return {
      trace: {
        id: traceRow.id as string,
        userId: traceRow.userId as string,
        traceSessionId: traceRow.traceSessionId as string,
        sessionId: traceRow.sessionId as string,
        executionId: (traceRow.executionId as string | null) ?? null,
        name: traceRow.name as string,
        status: traceRow.status as string,
        attributes: (traceRow.attributes as Record<string, unknown>) ?? {},
        startedAt: traceRow.startedAt as string,
        endedAt: (traceRow.endedAt as string | null) ?? null,
        durationMs: traceRow.durationMs != null ? Number(traceRow.durationMs) : null,
        createdAt: traceRow.createdAt as string,
      },
      spans: spans.rows.map((r) => ({
        id: r.id as string,
        parentSpanId: (r.parentSpanId as string | null) ?? null,
        name: r.name as string,
        phase: (r.phase as string | null) ?? null,
        kind: r.kind as string,
        status: r.status as string,
        attributes: (r.attributes as Record<string, unknown>) ?? {},
        startedAt: r.startedAt as string,
        endedAt: r.endedAt as string,
        durationMs: Number(r.durationMs ?? 0),
      })),
      costRows: costRows.rows.map((r) => ({
        agentName: (r.agentName as string | null) ?? null,
        modelName: (r.modelName as string | null) ?? null,
        inputTokens: Number(r.inputTokens ?? 0),
        outputTokens: Number(r.outputTokens ?? 0),
        estimatedCostMicros: String(r.estimatedCostMicros ?? 0),
        createdAt: r.createdAt as string,
      })),
      auditRows: auditRows.rows.map((r) => ({
        action: r.action as string,
        resourceType: (r.resourceType as string | null) ?? null,
        resourceId: (r.resourceId as string | null) ?? null,
        outcome: r.outcome as string,
        detail: (r.detail as Record<string, unknown>) ?? {},
        createdAt: r.createdAt as string,
      })),
    };
  }

  // ─── 管理操作（obs_manager，事务内执行） ───────────────────────────────

  /** 删除单条 trace：级联 span，并清理其 cost/audit 与孤儿 trace 会话。 */
  async deleteTrace(traceId: string): Promise<boolean> {
    const db = this.requireManager();
    await db.query("BEGIN");
    try {
      const del = await db.query(`DELETE FROM agent_traces WHERE id = $1`, [traceId]);
      const deleted = (del.rowCount ?? 0) > 0;
      if (deleted) {
        await db.query(`DELETE FROM cost_usage WHERE trace_id = $1`, [traceId]);
        await db.query(`DELETE FROM audit_logs WHERE trace_id = $1`, [traceId]);
        await this.cleanupOrphanTraceSessions(db);
      }
      await db.query("COMMIT");
      return deleted;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  /**
   * 按筛选批量清理 trace。dryRun 只统计不删除（用于前端预览）。
   * 返回匹配数量。
   */
  async pruneTraces(filters: TraceFilters, dryRun = false): Promise<number> {
    const db = this.requireManager();
    const params = traceFilterParams(filters);
    const clause = traceFilterClause();

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM agent_traces t${clause}`,
      params,
    );
    const matched = Number(countResult.rows[0]?.total ?? 0);
    if (dryRun || matched === 0) return matched;

    await db.query("BEGIN");
    try {
      // 一次选出匹配 id，再删关联行 + trace，避免同一子查询跑三遍
      await db.query(
        `WITH doomed AS (
           SELECT id FROM agent_traces t${clause}
         ),
         del_cost AS (
           DELETE FROM cost_usage WHERE trace_id IN (SELECT id FROM doomed)
         ),
         del_audit AS (
           DELETE FROM audit_logs WHERE trace_id IN (SELECT id FROM doomed)
         )
         DELETE FROM agent_traces WHERE id IN (SELECT id FROM doomed)`,
        params,
      );
      await this.cleanupOrphanTraceSessions(db);
      await db.query("COMMIT");
      return matched;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  /** 删除不再被任何 trace 引用的 agent_trace_sessions 行。 */
  private async cleanupOrphanTraceSessions(db: Database): Promise<void> {
    await db.query(
      `DELETE FROM agent_trace_sessions
       WHERE NOT EXISTS (SELECT 1 FROM agent_traces t WHERE t.trace_session_id = agent_trace_sessions.id)`,
    );
  }
}

function rowToListItem(r: pg.QueryResultRow): TraceListItem {
  return {
    id: r.id as string,
    name: r.name as string,
    mode: (r.mode as string | null) ?? null,
    status: r.status as string,
    userId: r.userId as string,
    sessionId: r.sessionId as string,
    executionId: (r.executionId as string | null) ?? null,
    startedAt: r.startedAt as string,
    endedAt: (r.endedAt as string | null) ?? null,
    durationMs: r.durationMs != null ? Number(r.durationMs) : null,
    inputTokens: Number(r.inputTokens ?? 0),
    outputTokens: Number(r.outputTokens ?? 0),
    costRows: Number(r.costRows ?? 0),
  };
}
