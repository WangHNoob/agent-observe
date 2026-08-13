import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import type { EvalCandidateStatus } from "../services/evalSamplerService.js";

/**
 * 在线评测采样候选池路由（flywheel 03-P4）。
 * - GET /api/eval/candidates       候选池列表（status/limit/offset 过滤）
 * - POST /api/eval/candidates/sample  手动触发一轮采样
 * - POST /api/eval/candidates/:id/status  标记 exported/dismissed（manager 可用时）
 * - GET  /api/eval/candidates/export    导出候选（knowledge-hub evals 兼容 JSON）
 *
 * 单管理员场景：JWT 鉴权即管理员；写路径全部走 obs_manager（未配置返回 503）。
 */
export async function evalCandidatesRoutes(
  app: FastifyInstance,
  opts: { ctx: RouteContext },
): Promise<void> {
  app.get(
    "/api/eval/candidates",
    { preHandler: opts.ctx.authenticate },
    async (req) => {
      const query = req.query as { status?: string; limit?: string; offset?: string };
      const status = query.status === "pending" || query.status === "exported" || query.status === "dismissed"
        ? (query.status as EvalCandidateStatus)
        : undefined;
      const candidates = await opts.ctx.evalSamplerService.listCandidates({
        status,
        limit: Number(query.limit ?? 100),
        offset: Number(query.offset ?? 0),
      });
      return {
        samplingEnabled: opts.ctx.evalSamplerService.enabled,
        candidates,
      };
    },
  );

  app.post(
    "/api/eval/candidates/sample",
    { preHandler: opts.ctx.authenticate },
    async (_req, reply) => {
      const result = await opts.ctx.evalSamplerService.runSampling();
      if (result.sampled === 0 && !opts.ctx.evalSamplerService.enabled) {
        return reply.code(503).send({ error: "eval sampling disabled: OBS_MANAGER_DATABASE_URL not configured" });
      }
      return result;
    },
  );

  app.post(
    "/api/eval/candidates/:id/status",
    { preHandler: opts.ctx.authenticate },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { status?: string; actor?: string };
      const status = body.status === "exported" || body.status === "dismissed"
        ? body.status
        : null;
      if (!status) {
        return reply.code(400).send({ error: "status must be exported | dismissed" });
      }
      const ok = await opts.ctx.evalSamplerService.markStatus(params.id, status, body.actor ?? "admin");
      if (!ok) {
        return reply.code(503).send({ error: "eval candidate management disabled: OBS_MANAGER_DATABASE_URL not configured" });
      }
      return { ok };
    },
  );

  app.get(
    "/api/eval/candidates/export",
    { preHandler: opts.ctx.authenticate },
    async (_req, reply) => {
      const payload = await opts.ctx.evalSamplerService.exportCandidates();
      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="eval-candidates-${Date.now()}.json"`)
        .send(payload);
    },
  );
}
