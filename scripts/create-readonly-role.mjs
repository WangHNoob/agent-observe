#!/usr/bin/env node
/**
 * 一次性创建数据库角色（对 design-agent 共享库执行，幂等）。
 *
 * 两个角色：
 *   - obs_reader   只读：SELECT（agent-observe 查询路径）
 *   - obs_manager  管理：SELECT/DELETE/INSERT（删除 trace、TTL 清理、测试 fixture）
 *
 * 用法：
 *   node scripts/create-readonly-role.mjs
 *
 * 需要管理员连接串（默认：docker-compose 的 game_designer 超级用户）。
 * 可用环境变量覆盖：
 *   OBS_ADMIN_DB_URL=postgresql://user:pass@localhost:5433/game_designer
 *   OBS_READER_PASSWORD=obs_reader_dev
 *   OBS_MANAGER_PASSWORD=obs_manager_dev
 */
import pg from "pg";

const ADMIN_URL =
  process.env.OBS_ADMIN_DB_URL ??
  "postgresql://game_designer:game_designer@localhost:5433/game_designer";
const READER_PASSWORD = process.env.OBS_READER_PASSWORD ?? "obs_reader_dev";
const MANAGER_PASSWORD = process.env.OBS_MANAGER_PASSWORD ?? "obs_manager_dev";

const client = new pg.Client({ connectionString: ADMIN_URL });

await client.connect();
try {
  // ── obs_reader：只读 ─────────────────────────────────────────────
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
  console.log("[ok] obs_reader ready (read-only)");

  // ── obs_manager：SELECT/DELETE/INSERT（管理路径；INSERT 供测试 fixture）──
  await client.query(
    `DO $do$
     BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'obs_manager') THEN
         CREATE ROLE obs_manager LOGIN PASSWORD '${MANAGER_PASSWORD}';
       END IF;
     END $do$`,
  );
  await client.query("GRANT CONNECT ON DATABASE game_designer TO obs_manager");
  await client.query("GRANT USAGE ON SCHEMA public TO obs_manager");
  await client.query("GRANT SELECT, DELETE, INSERT ON ALL TABLES IN SCHEMA public TO obs_manager");
  await client.query(
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, DELETE, INSERT ON TABLES TO obs_manager",
  );
  console.log("[ok] obs_manager ready (select/delete/insert)");
} finally {
  await client.end();
}
