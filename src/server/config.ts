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
  };
}
