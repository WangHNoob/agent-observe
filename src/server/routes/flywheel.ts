import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

/** 知识飞轮回流状态与已上报信号查询。 */
export async function flywheelRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/flywheel/status",
    { preHandler: opts.ctx.authenticate },
    async () => ({
      enabled: opts.ctx.flywheelReporter.enabled,
      dryRun: opts.ctx.flywheelReporter.dryRun,
    }),
  );

  app.get(
    "/api/flywheel/reports",
    { preHandler: opts.ctx.authenticate },
    async (req) => {
      const query = req.query as { limit?: string };
      const rawLimit = Number(query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
      const reports = await opts.ctx.flywheelReporter.recentReports(limit);
      return { enabled: opts.ctx.flywheelReporter.enabled, reports };
    },
  );
}
