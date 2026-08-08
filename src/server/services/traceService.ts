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

const TRACE_LIST_SELECT = `
  SELECT t.id, t.name, t.status, t.user_id AS "userId",
         t.session_id AS "sessionId", t.execution_id AS "executionId",
         t.started_at AS "startedAt", t.ended_at AS "endedAt",
         EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000 AS "durationMs",
         split_part(t.name, '.', 2) AS mode,
         COALESCE(SUM(c.input_tokens), 0)::int AS "inputTokens",
         COALESCE(SUM(c.output_tokens), 0)::int AS "outputTokens",
         COUNT(c.id)::int AS "costRows"
  FROM agent_traces t
  LEFT JOIN cost_usage c ON c.trace_id = t.id`;

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

export class TraceService {
  constructor(private readonly db: Database) {}

  async listTraces(
    filters: TraceFilters,
  ): Promise<{ items: TraceListItem[]; total: number }> {
    const rawLimit = filters.limit ?? 50;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50;
    const rawOffset = filters.offset ?? 0;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
    const params = traceFilterParams(filters);

    const items = await this.db.query<pg.QueryResultRow>(
      `${TRACE_LIST_SELECT}${traceFilterClause()}
       GROUP BY t.id
       ORDER BY t.started_at DESC
       LIMIT $9 OFFSET $10`,
      [...params, limit, offset],
    );

    const count = await this.db.query<pg.QueryResultRow>(
      `SELECT COUNT(*)::int AS total FROM agent_traces t${traceFilterClause()}`,
      params,
    );

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
