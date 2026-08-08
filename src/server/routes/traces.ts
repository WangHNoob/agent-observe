import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouteContext } from "../app.js";
import { ManagementDisabledError, type TraceFilters } from "../services/traceService.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const STATUSES = new Set(["ok", "error", "unset"]);
const MODES = new Set(["query", "design", "table"]);

function parseListQuery(req: FastifyRequest): TraceFilters {
  const q = req.query as Record<string, string | undefined>;
  const filters: TraceFilters = {};
  if (q.userId) filters.userId = q.userId;
  if (q.sessionId) filters.sessionId = q.sessionId;
  if (q.executionId) filters.executionId = q.executionId;
  if (q.name) filters.name = q.name;
  if (q.mode && MODES.has(q.mode)) filters.mode = q.mode;
  if (q.status && STATUSES.has(q.status)) filters.status = q.status as TraceFilters["status"];
  if (q.from) filters.from = q.from;
  if (q.to) filters.to = q.to;
  if (q.limit) filters.limit = Number(q.limit);
  if (q.offset) filters.offset = Number(q.offset);
  return filters;
}

function parseFilterBody(body: unknown): TraceFilters {
  const b = (body ?? {}) as {
    filters?: Partial<TraceFilters>;
    status?: string;
    mode?: string;
    name?: string;
    sessionId?: string;
    executionId?: string;
    userId?: string;
    from?: string;
    to?: string;
  };
  const src = b.filters ?? b;
  const filters: TraceFilters = {};
  if (src.userId) filters.userId = src.userId;
  if (src.sessionId) filters.sessionId = src.sessionId;
  if (src.executionId) filters.executionId = src.executionId;
  if (src.name) filters.name = src.name;
  if (src.mode && MODES.has(src.mode)) filters.mode = src.mode;
  if (src.status && STATUSES.has(src.status)) filters.status = src.status as TraceFilters["status"];
  if (src.from) filters.from = src.from;
  if (src.to) filters.to = src.to;
  return filters;
}

export async function tracesRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/traces",
    { preHandler: opts.ctx.authenticate },
    async (req) => {
      const { items, total } = await opts.ctx.traceService.listTraces(parseListQuery(req));
      return { items, total };
    },
  );

  app.get(
    "/api/traces/:id",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!ID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "Invalid traceId" });
      }
      const detail = await opts.ctx.traceService.getTraceDetail(id);
      if (!detail) {
        return reply.code(404).send({ error: "Trace not found" });
      }
      return detail;
    },
  );

  // ─── 管理操作（需 obs_manager 连接，未配置时 503） ───────────────────

  app.delete(
    "/api/traces/:id",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!ID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "Invalid traceId" });
      }
      try {
        const deleted = await opts.ctx.traceService.deleteTrace(id);
        if (!deleted) {
          return reply.code(404).send({ error: "Trace not found" });
        }
        return { deleted: true, id };
      } catch (err) {
        if (err instanceof ManagementDisabledError) {
          return reply.code(503).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    "/api/traces/prune",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const body = (req.body ?? {}) as { dryRun?: boolean };
      const filters = parseFilterBody(req.body);
      try {
        const matched = await opts.ctx.traceService.pruneTraces(filters, body.dryRun !== false);
        return { matched, dryRun: body.dryRun !== false };
      } catch (err) {
        if (err instanceof ManagementDisabledError) {
          return reply.code(503).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
