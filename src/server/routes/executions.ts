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
      const q = req.query as { include?: string };
      const includePrimaryTrace =
        q.include === "primaryTrace" ||
        (typeof q.include === "string" && q.include.split(",").includes("primaryTrace"));

      const detail = await opts.ctx.executionService.getExecution(id);
      if (!detail) {
        return reply.code(404).send({ error: "Execution not found" });
      }

      if (!includePrimaryTrace) {
        return detail;
      }

      const primaryTrace = await opts.ctx.traceService.getPrimaryTraceByExecution(id);
      return { ...detail, primaryTrace };
    },
  );
}
