import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { executionsRoutes } from "./routes/executions.js";
import { overviewRoutes } from "./routes/overview.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { tracesRoutes } from "./routes/traces.js";
import { ExecutionService } from "./services/executionService.js";
import { OverviewService } from "./services/overviewService.js";
import { SessionService } from "./services/sessionService.js";
import { TraceService } from "./services/traceService.js";

export interface RouteContext {
  config: AppConfig;
  db: Database;
  traceService: TraceService;
  overviewService: OverviewService;
  executionService: ExecutionService;
  sessionService: SessionService;
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Database;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = options;
  // 管理连接（obs_manager）：删除/清理用；未配置时管理功能整体禁用。
  const managerDb = config.managerDatabaseUrl
    ? createDatabase(config.managerDatabaseUrl)
    : undefined;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(jwt, { secret: config.jwtSecret });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "Unauthorized" });
    }
  };

  const ctx: RouteContext = {
    config,
    db,
    traceService: new TraceService(db, managerDb),
    overviewService: new OverviewService(db, {
      retentionDays: config.traceRetentionDays,
      pruneAvailable: managerDb != null,
    }),
    executionService: new ExecutionService(db),
    sessionService: new SessionService(db),
    authenticate,
  };

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(authRoutes, { ctx });
  await app.register(overviewRoutes, { ctx });
  await app.register(tracesRoutes, { ctx });
  await app.register(executionsRoutes, { ctx });
  await app.register(sessionsRoutes, { ctx });

  // Trace 保留（TTL）清理器：按配置天数定期删除过期 trace。
  // 仅当配置了 obs_manager 连接且保留天数 > 0 时启用。
  if (managerDb && config.traceRetentionDays > 0) {
    const sweep = async (): Promise<void> => {
      try {
        const cutoff = new Date(Date.now() - config.traceRetentionDays * 86_400_000).toISOString();
        const matched = await ctx.traceService.pruneTraces({ to: cutoff });
        if (matched > 0) {
          app.log.info(`[retention] pruned ${matched} traces older than ${config.traceRetentionDays}d`);
        }
      } catch (err) {
        app.log.error(`[retention] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void sweep(); // 启动即清一次
    const timer = setInterval(sweep, config.retentionSweepIntervalMs);
    timer.unref();
    app.log.info(
      `[retention] TTL enabled: ${config.traceRetentionDays}d, sweep every ${Math.round(config.retentionSweepIntervalMs / 60_000)}m`,
    );
  }

  // 生产模式：托管构建好的前端 SPA（非 /api 路径回退 index.html）
  const here = dirname(fileURLToPath(import.meta.url));
  const clientDir = resolve(here, "../../dist/client");
  if (existsSync(clientDir)) {
    await app.register(fastifyStatic, { root: clientDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    const message = err instanceof Error ? err.message : "Internal error";
    const status = typeof err === "object" && err !== null && "statusCode" in err ? (err as { statusCode?: number }).statusCode : undefined;
    return reply.code(status ?? 500).send({ error: message });
  });

  return app;
}
