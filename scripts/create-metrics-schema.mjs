#!/usr/bin/env node
/**
 * 一次性创建观测台自有指标 schema（对 design-agent 共享库执行，幂等）。
 *
 * 与共享表严格分界：指标表位于独立 schema obs_metrics，不触碰 public 下的
 * design-agent 表。授权：
 *   - obs_reader   仅 SELECT（趋势查询）
 *   - obs_manager  SELECT/INSERT/UPDATE/DELETE（聚合写入与清理）
 *
 * 用法：
 *   node scripts/create-metrics-schema.mjs
 *
 * 可用环境变量覆盖：
 *   OBS_ADMIN_DB_URL=postgresql://user:pass@localhost:5433/game_designer
 */
import pg from "pg";

const ADMIN_URL =
  process.env.OBS_ADMIN_DB_URL ??
  "postgresql://game_designer:game_designer@localhost:5433/game_designer";

const client = new pg.Client({ connectionString: ADMIN_URL });

await client.connect();
try {
  // ── schema：观测台自有指标域 ──────────────────────────────────────
  await client.query(
    `DO $do$
     BEGIN
       IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'obs_metrics') THEN
         CREATE SCHEMA obs_metrics;
       END IF;
     END $do$`,
  );

  // ── 表：小时级聚合（幂等创建）──────────────────────────────────────
  await client.query(
    `CREATE TABLE IF NOT EXISTS obs_metrics.metric_hourly (
       bucket_hour       timestamptz NOT NULL,
       mode              text NOT NULL,
       status            text NOT NULL,
       n                 integer NOT NULL DEFAULT 0,
       error_n           integer NOT NULL DEFAULT 0,
       input_tokens      bigint NOT NULL DEFAULT 0,
       output_tokens     bigint NOT NULL DEFAULT 0,
       cost_micros       numeric NOT NULL DEFAULT 0,
       p50_duration_ms   double precision,
       p95_duration_ms   double precision,
       max_duration_ms   double precision,
       created_at        timestamptz NOT NULL DEFAULT NOW(),
       updated_at        timestamptz NOT NULL DEFAULT NOW(),
       PRIMARY KEY (bucket_hour, mode, status)
     )`,
  );

  // ── 授权 ──────────────────────────────────────────────────────────
  await client.query("GRANT USAGE ON SCHEMA obs_metrics TO obs_reader");
  await client.query("GRANT SELECT ON obs_metrics.metric_hourly TO obs_reader");

  await client.query("GRANT USAGE ON SCHEMA obs_metrics TO obs_manager");
  await client.query(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON obs_metrics.metric_hourly TO obs_manager",
  );

  // 未来新表自动授权（防漏）
  await client.query("ALTER DEFAULT PRIVILEGES IN SCHEMA obs_metrics GRANT SELECT ON TABLES TO obs_reader");
  await client.query(
    "ALTER DEFAULT PRIVILEGES IN SCHEMA obs_metrics GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO obs_manager",
  );

  console.log("[ok] obs_metrics.metric_hourly ready (reader=SELECT, manager=SELECT/INSERT/UPDATE/DELETE)");
} finally {
  await client.end();
}
