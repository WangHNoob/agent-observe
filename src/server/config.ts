/**
 * agent-observe 配置加载。
 * 与 design-agent 解耦：只读连接共享 PostgreSQL（obs_reader 角色），其余均为本工程自管配置。
 */
export interface AppConfig {
  /** 只读连接串（默认指向 design-agent 共享库的 obs_reader 角色） */
  databaseUrl: string;
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
    jwtSecret: required("OBS_JWT_SECRET", env),
    adminPassword: required("OBS_ADMIN_PASSWORD", env),
    port: Number(env.PORT ?? 4180),
    host: env.HOST ?? "0.0.0.0",
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5180",
  };
}
