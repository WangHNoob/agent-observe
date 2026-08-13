/**
 * agent-observe 配置加载。
 * 与 design-agent 解耦：只读连接共享 PostgreSQL（obs_reader 角色），其余均为本工程自管配置。
 */
export interface AppConfig {
  /** 只读连接串（默认指向 design-agent 共享库的 obs_reader 角色） */
  databaseUrl: string;
  /** 管理连接串（obs_manager：删除/清理）。未配置时管理功能禁用。 */
  managerDatabaseUrl?: string;
  /** trace 保留天数（TTL）：started_at 早于该值会被后台清理器删除；0 = 禁用清理 */
  traceRetentionDays: number;
  /** 保留清理器运行间隔（毫秒） */
  retentionSweepIntervalMs: number;
  /** JWT 签名密钥 */
  jwtSecret: string;
  /** 单管理员登录密码（本地/自部署场景，不做多用户体系） */
  adminPassword: string;
  port: number;
  host: string;
  /** 开发时前端（Vite 5180）跨域来源 */
  corsOrigin: string;
  /** schema 契约校验：严格模式发现漂移直接启动失败；false 降级为仅告警 */
  schemaStrict: boolean;
  /** 指标聚合周期（毫秒），默认 1 小时 */
  metricsIntervalMs: number;
  /** 告警评估周期（毫秒），默认 10 分钟 */
  alertIntervalMs: number;
  /** 告警 webhook URL（钉钉/飞书/企业微信）；不配置则仅站内记录 */
  alertWebhookUrl?: string;
  /** 告警规则阈值（可覆盖默认值） */
  alertThresholds: {
    errorRate: number;
    errorRateMinTraces: number;
    tokenStormThreshold: number;
    costSpikeThresholdMicros: number;
    timeoutSpikeThreshold: number;
    hitlStallHours: number;
  };
  /** 知识库飞轮回流（观测信号 → knowledge-hub） */
  flywheel: {
    /** knowledge-hub 基址；未配置则回流禁用 */
    khUrl?: string;
    /** knowledge-hub service account JWT（经 /api/auth/login 获取） */
    khToken?: string;
    /** 评估周期（毫秒），默认 10 分钟 */
    intervalMs: number;
    /** dry-run：只打印将上报的信号，不上报不落库（灰度开关） */
    dryRun: boolean;
    /** 目标项目（默认 default_project） */
    projectId: string;
    /** 规则阈值 */
    thresholds: {
      /** R1：同需求 execution 错误率 ≥ 该值（0-1） */
      errorRate: number;
      /** R1：同需求 execution 失败数 ≥ 该值 */
      minErrors: number;
      /** R2：1h 超时数 ≥ 该值 */
      minTimeouts: number;
      /** R3：1h 同工具失败数 ≥ 该值 */
      minToolErrors: number;
      /** R4：24h 成本阈值（estimated_cost_micros） */
      costThresholdMicros: number;
      /** 幂等窗口（小时），同信号窗口内不重复上报 */
      dedupeWindowHours: number;
    };
  };
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl:
      env.OBS_DATABASE_URL ??
      "postgresql://obs_reader:obs_reader_dev@localhost:5433/game_designer?options=-c%20default_transaction_read_only%3Don",
    managerDatabaseUrl: env.OBS_MANAGER_DATABASE_URL || undefined,
    traceRetentionDays: Number(env.OBS_TRACE_RETENTION_DAYS ?? 90),
    retentionSweepIntervalMs: Number(env.OBS_RETENTION_SWEEP_INTERVAL_MS ?? 3_600_000),
    jwtSecret: required("OBS_JWT_SECRET", env),
    adminPassword: required("OBS_ADMIN_PASSWORD", env),
    port: Number(env.PORT ?? 4180),
    host: env.HOST ?? "0.0.0.0",
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5180",
    schemaStrict: env.OBS_SCHEMA_STRICT !== "false",
    metricsIntervalMs: Number(env.OBS_METRICS_INTERVAL_MS ?? 3_600_000),
    alertIntervalMs: Number(env.OBS_ALERT_INTERVAL_MS ?? 600_000),
    alertWebhookUrl: env.OBS_ALERT_WEBHOOK_URL || undefined,
    alertThresholds: {
      errorRate: Number(env.OBS_ALERT_ERROR_RATE ?? 0.2),
      errorRateMinTraces: Number(env.OBS_ALERT_ERROR_MIN_TRACES ?? 10),
      tokenStormThreshold: Number(env.OBS_ALERT_TOKEN_THRESHOLD ?? 400_000),
      costSpikeThresholdMicros: Number(env.OBS_ALERT_COST_THRESHOLD_MICROS ?? 5_000_000),
      timeoutSpikeThreshold: Number(env.OBS_ALERT_TIMEOUT_THRESHOLD ?? 3),
      hitlStallHours: Number(env.OBS_ALERT_HITL_STALL_HOURS ?? 24),
    },
    flywheel: {
      khUrl: env.OBS_FLYWHEEL_KH_URL || undefined,
      khToken: env.OBS_FLYWHEEL_KH_TOKEN || undefined,
      intervalMs: Number(env.OBS_FLYWHEEL_INTERVAL_MS ?? 600_000),
      dryRun: env.OBS_FLYWHEEL_DRY_RUN !== "false",
      projectId: env.OBS_FLYWHEEL_PROJECT_ID ?? "default_project",
      thresholds: {
        errorRate: Number(env.OBS_FLYWHEEL_ERROR_RATE ?? 0.5),
        minErrors: Number(env.OBS_FLYWHEEL_MIN_ERRORS ?? 3),
        minTimeouts: Number(env.OBS_FLYWHEEL_MIN_TIMEOUTS ?? 3),
        minToolErrors: Number(env.OBS_FLYWHEEL_MIN_TOOL_ERRORS ?? 3),
        costThresholdMicros: Number(env.OBS_FLYWHEEL_COST_THRESHOLD_MICROS ?? 5_000_000),
        dedupeWindowHours: Number(env.OBS_FLYWHEEL_DEDUPE_HOURS ?? 24),
      },
    },
  };
}
