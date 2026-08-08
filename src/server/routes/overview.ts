import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

export async function overviewRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/overview",
    { preHandler: opts.ctx.authenticate },
    async () => opts.ctx.overviewService.getOverview(),
  );
}
