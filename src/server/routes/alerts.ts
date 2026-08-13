import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

/** 告警查询与管理路由（数据源 obs_metrics.alerts）。 */
export async function alertsRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/alerts",
    { preHandler: opts.ctx.authenticate },
    async (req) => {
      const query = req.query as { limit?: string };
      const rawLimit = Number(query.limit ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
      const alerts = await opts.ctx.alertService.list(limit);
      return {
        alertsEnabled: opts.ctx.alertService.enabled,
        alerts,
      };
    },
  );

  app.post(
    "/api/alerts/:id/resolve",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = (req.body ?? {}) as { by?: string };
      const ok = await opts.ctx.alertService.resolve(params.id, body.by ?? "admin");
      if (!ok) {
        return reply.code(404).send({ error: "Alert not found or already resolved" });
      }
      return { ok: true };
    },
  );
}
