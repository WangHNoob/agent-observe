import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

/** 指标查询路由：小时级聚合趋势（数据源 obs_metrics.metric_hourly）。 */
export async function metricsRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/metrics/trend",
    { preHandler: opts.ctx.authenticate },
    async (req) => {
      const query = req.query as { days?: string };
      const rawDays = Number(query.days ?? 7);
      const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
      const points = await opts.ctx.metricsService.getTrend(days);
      return {
        days,
        metricsEnabled: opts.ctx.metricsService.enabled,
        points,
      };
    },
  );
}
