import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

export async function executionsRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/executions/:id",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!ID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "Invalid executionId" });
      }
      const detail = await opts.ctx.executionService.getExecution(id);
      if (!detail) {
        return reply.code(404).send({ error: "Execution not found" });
      }
      return detail;
    },
  );
}
