import { apiFetch, queryString, setToken } from "./http";

// ─── 类型（与后端 services 对齐） ────────────────────────────────────────

export interface OverviewData {
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
  trend: { bucket: string; n: number; errors: number }[];
  recentErrors: { id: string; name: string; startedAt: string; durationMs: number | null }[];
  retentionDays: number;
  pruneAvailable: boolean;
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

export interface Span {
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
  spans: Span[];
  spansLite: boolean;
  executionSummary: {
    requirement: string | null;
    output: string | null;
  } | null;
  costRows: {
    agentName: string | null;
    modelName: string | null;
    inputTokens: number;
    outputTokens: number;
    estimatedCostMicros: string;
    createdAt: string;
  }[];
  auditRows: {
    action: string;
    resourceType: string | null;
    resourceId: string | null;
    outcome: string;
    detail: Record<string, unknown>;
    createdAt: string;
  }[];
}

export interface ExecutionDetail {
  execution: {
    id: string;
    userId: string;
    sessionId: string;
    idempotencyKey: string;
    status: string;
    requestPayload: Record<string, unknown>;
    planPayload: Record<string, unknown> | null;
    resultPayload: Record<string, unknown> | null;
    errorClass: string | null;
    errorMessage: string | null;
    deadlineAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  };
  tasks: {
    id: string;
    taskKey: string;
    name: string;
    agentName: string | null;
    status: string;
    dependencies: unknown;
    position: number;
    errorClass: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    attempts: {
      attemptNumber: number;
      status: string;
      errorClass: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      startedAt: string;
      finishedAt: string | null;
    }[];
  }[];
  /** include=primaryTrace 时附带 */
  primaryTrace?: TraceDetail | null;
}

export interface TraceFilters {
  mode?: string;
  status?: string;
  name?: string;
  sessionId?: string;
  executionId?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ─── API ─────────────────────────────────────────────────────────────────

export async function login(password: string): Promise<void> {
  const res = await apiFetch<{ token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  setToken(res.token);
}

export function fetchOverview(): Promise<OverviewData> {
  return apiFetch("/api/overview");
}

export function fetchMeta(): Promise<{ retentionDays: number; pruneAvailable: boolean }> {
  return apiFetch("/api/meta");
}

export function fetchTraces(filters: TraceFilters): Promise<{ items: TraceListItem[]; total: number }> {
  return apiFetch(`/api/traces${queryString(filters as Record<string, string | number | undefined>)}`);
}

export function fetchTrace(id: string, opts?: { full?: boolean }): Promise<TraceDetail> {
  const qs = opts?.full ? "?full=1" : "";
  return apiFetch(`/api/traces/${encodeURIComponent(id)}${qs}`);
}

export function fetchSpan(traceId: string, spanId: string): Promise<Span> {
  return apiFetch(
    `/api/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}`,
  );
}

export function fetchExecution(
  id: string,
  opts?: { includePrimaryTrace?: boolean },
): Promise<ExecutionDetail> {
  const qs = opts?.includePrimaryTrace ? "?include=primaryTrace" : "";
  return apiFetch(`/api/executions/${encodeURIComponent(id)}${qs}`);
}

// ─── 管理（删除 / 清理；后端无 obs_manager 连接时返回 503） ──────────────

export function deleteTrace(id: string): Promise<{ deleted: boolean; id: string }> {
  return apiFetch(`/api/traces/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function pruneTraces(
  filters: TraceFilters,
  dryRun: boolean,
): Promise<{ matched: number; dryRun: boolean }> {
  return apiFetch("/api/traces/prune", {
    method: "POST",
    body: JSON.stringify({ filters, dryRun }),
  });
}
