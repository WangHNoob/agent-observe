import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

export async function sessionsRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
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
