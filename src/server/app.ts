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
import { alertsRoutes } from "./routes/alerts.js";
import { flywheelRoutes } from "./routes/flywheel.js";
import { executionsRoutes } from "./routes/executions.js";
import { metricsRoutes } from "./routes/metrics.js";
import { overviewRoutes } from "./routes/overview.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { tracesRoutes } from "./routes/traces.js";
import { AlertService } from "./services/alertService.js";
import { FlywheelReporter } from "./services/flywheelReporter.js";
import { ExecutionService } from "./services/executionService.js";
import { MetricsService } from "./services/metricsService.js";
import { OverviewService } from "./services/overviewService.js";
import { SessionService } from "./services/sessionService.js";
import { TraceService } from "./services/traceService.js";
import { loadSchemaContract, verifySchemaContract } from "./schemaContract.js";

export interface RouteContext {
  config: AppConfig;
  db: Database;
  traceService: TraceService;
  overviewService: OverviewService;
  executionService: ExecutionService;
  sessionService: SessionService;
  metricsService: MetricsService;
  alertService: AlertService;
  flywheelReporter: FlywheelReporter;
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

  const metricsService = new MetricsService(db, managerDb, {
    retentionDays: config.traceRetentionDays,
    log: (level, message) => {
      if (level === "error") app.log.error(message);
      else if (level === "warn") app.log.warn(message);
      else app.log.info(message);
    },
  });

  const alertService = new AlertService(db, managerDb, {
    thresholds: config.alertThresholds,
    webhookUrl: config.alertWebhookUrl,
    log: (level, message) => {
      if (level === "error") app.log.error(message);
      else if (level === "warn") app.log.warn(message);
      else app.log.info(message);
    },
  });

  const flywheelReporter = new FlywheelReporter(db, managerDb, {
    khUrl: config.flywheel.khUrl,
    khToken: config.flywheel.khToken,
    dryRun: config.flywheel.dryRun,
    projectId: config.flywheel.projectId,
    thresholds: config.flywheel.thresholds,
    log: (level, message) => {
      if (level === "error") app.log.error(message);
      else if (level === "warn") app.log.warn(message);
      else app.log.info(message);
    },
  });

  const ctx: RouteContext = {
    config,
    db,
    traceService: new TraceService(db, managerDb),
    overviewService: new OverviewService(
      db,
      {
        retentionDays: config.traceRetentionDays,
        pruneAvailable: managerDb != null,
      },
      metricsService,
    ),
    executionService: new ExecutionService(db),
    sessionService: new SessionService(db),
    metricsService,
    alertService,
    flywheelReporter,
    authenticate,
  };

  // ── schema 契约校验：启动即检，漂移 fail-fast（可降级为告警）──
  const contract = loadSchemaContract();
  const contractReport = await verifySchemaContract(db, contract);
  if (!contractReport.ok) {
    const detail = contractReport.issues
      .map((i) => `${i.kind} ${i.table}${i.column ? "." + i.column : ""} (expected ${i.expected}, got ${i.actual})`)
      .join("; ");
    const message = `[schema-contract] drift detected (v${contractReport.schemaVersion}): ${detail}`;
    if (config.schemaStrict) {
      throw new Error(message);
    }
    app.log.warn(`${message} — running in non-strict mode`);
  } else {
    app.log.info(`[schema-contract] ok: ${contractReport.checkedTables} tables match v${contractReport.schemaVersion}`);
  }

  app.get("/api/health", async () => ({ ok: true }));

  // 轻量元信息（无 DB）：TraceList 只需保留策略，不必拉完整 overview
  app.get(
    "/api/meta",
    { preHandler: authenticate },
    async () => ({
      retentionDays: config.traceRetentionDays,
      pruneAvailable: managerDb != null,
    }),
  );

  await app.register(authRoutes, { ctx });
  await app.register(overviewRoutes, { ctx });
  await app.register(tracesRoutes, { ctx });
  await app.register(executionsRoutes, { ctx });
  await app.register(sessionsRoutes, { ctx });
  await app.register(metricsRoutes, { ctx });
  await app.register(alertsRoutes, { ctx });
  await app.register(flywheelRoutes, { ctx });

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

  // ── schema 契约定时复检：漂移发现延迟 ≤ 1 个调度周期 ──
  const contractCheck = async (): Promise<void> => {
    try {
      const report = await verifySchemaContract(db, contract);
      if (!report.ok) {
        const detail = report.issues
          .map((i) => `${i.kind} ${i.table}${i.column ? "." + i.column : ""}`)
          .join("; ");
        app.log.warn(`[schema-contract] periodic check found drift: ${detail}`);
        await ctx.alertService.raiseSchemaDrift(detail);
      }
    } catch (err) {
      app.log.error(`[schema-contract] periodic check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const contractTimer = setInterval(contractCheck, config.retentionSweepIntervalMs);
  contractTimer.unref();

  // ── 指标聚合：小时级写入 obs_metrics（需 obs_manager；未配置则禁用）──
  if (ctx.metricsService.enabled) {
    void ctx.metricsService.runScheduledAggregate(); // 启动即补一次上一小时
    const metricsTimer = setInterval(
      () => void ctx.metricsService.runScheduledAggregate(),
      config.metricsIntervalMs,
    );
    metricsTimer.unref();
    app.log.info(
      `[metrics] hourly aggregation enabled, interval ${Math.round(config.metricsIntervalMs / 60_000)}m`,
    );
  } else {
    app.log.warn("[metrics] aggregation disabled: OBS_MANAGER_DATABASE_URL not configured");
  }

  // ── 告警评估：基于指标表与实时查询的规则触发/恢复（需 obs_manager）──
  if (ctx.alertService.enabled) {
    void ctx.alertService.runScheduledEvaluation(); // 启动即评估一次
    const alertTimer = setInterval(
      () => void ctx.alertService.runScheduledEvaluation(),
      config.alertIntervalMs,
    );
    alertTimer.unref();
    app.log.info(
      `[alerts] evaluation enabled, interval ${Math.round(config.alertIntervalMs / 60_000)}m`,
    );
  } else {
    app.log.warn("[alerts] evaluation disabled: OBS_MANAGER_DATABASE_URL not configured");
  }

  // ── 知识飞轮回流：观测信号 → knowledge-hub（幂等 + dry-run 灰度）──
  if (ctx.flywheelReporter.enabled) {
    void ctx.flywheelReporter.runScheduledEvaluation(); // 启动即评估一次
    const flywheelTimer = setInterval(
      () => void ctx.flywheelReporter.runScheduledEvaluation(),
      config.flywheel.intervalMs,
    );
    flywheelTimer.unref();
    app.log.info(
      `[flywheel] reporter enabled (dryRun=${config.flywheel.dryRun}), interval ${Math.round(config.flywheel.intervalMs / 60_000)}m`,
    );
  } else {
    app.log.warn(
      "[flywheel] reporter disabled: set OBS_FLYWHEEL_KH_URL + OBS_FLYWHEEL_KH_TOKEN (+ OBS_MANAGER_DATABASE_URL)",
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
