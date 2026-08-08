#!/usr/bin/env node
/**
 * 一次性创建只读角色 obs_reader 并授权（对 design-agent 共享库执行，纯只读授权）。
 *
 * 用法：
 *   node scripts/create-readonly-role.mjs
 *
 * 需要管理员连接串（默认：docker-compose 的 game_designer 超级用户）。
 * 可用环境变量覆盖：
 *   OBS_ADMIN_DB_URL=postgresql://user:pass@localhost:5433/game_designer
 *   OBS_READER_PASSWORD=obs_reader_dev
 */
import pg from "pg";

const ADMIN_URL =
  process.env.OBS_ADMIN_DB_URL ??
  "postgresql://game_designer:game_designer@localhost:5433/game_designer";
const READER_PASSWORD = process.env.OBS_READER_PASSWORD ?? "obs_reader_dev";

const client = new pg.Client({ connectionString: ADMIN_URL });

await client.connect();
try {
  await client.query(
    `DO $do$
     BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'obs_reader') THEN
         CREATE ROLE obs_reader LOGIN PASSWORD '${READER_PASSWORD}';
       END IF;
     END $do$`,
  );
  await client.query("GRANT CONNECT ON DATABASE game_designer TO obs_reader");
  await client.query("GRANT USAGE ON SCHEMA public TO obs_reader");
  await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO obs_reader");
  await client.query(
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO obs_reader",
  );
  console.log("[ok] obs_reader role ready (read-only)");
} finally {
  await client.end();
}
