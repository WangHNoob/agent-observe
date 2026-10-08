import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import type { SessionFilters } from "../services/sessionService.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const MODES = new Set(["query", "design", "table"]);
const STATUSES = new Set(["running", "completed", "failed", "cancelled"]);

export async function sessionsRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  // 会话列表（静态路由需先于 :id 注册；Fastify 静态优先，二者本就不冲突）
  app.get("/api/sessions", { preHandler: opts.ctx.authenticate }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const filters: SessionFilters = {
      mode: q.mode && MODES.has(q.mode) ? q.mode : undefined,
      status: q.status && STATUSES.has(q.status) ? q.status : undefined,
      q: q.q || undefined,
      limit: q.limit != null ? Number(q.limit) : undefined,
      offset: q.offset != null ? Number(q.offset) : undefined,
    };
    return opts.ctx.sessionService.listSessions(filters);
  });

  app.get(
    "/api/sessions/:id",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!ID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "Invalid sessionId" });
      }
      const detail = await opts.ctx.sessionService.getSession(id);
      if (!detail) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return detail;
    },
  );
}
