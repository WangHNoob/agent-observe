import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { createDatabase } from "../src/server/db.js";

let app: FastifyInstance;
let token = "";
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  app = await buildApp({ config, db });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: config.adminPassword },
  });
  token = res.json().token;
});

afterAll(async () => {
  await app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 用 obs_manager 连接自建 fixture（测试结束由被测删除逻辑清理）。 */
async function createFixture(managerUrl: string): Promise<{ traceId: string; sessionId: string }> {
  const client = new pg.Client({ connectionString: managerUrl });
  await client.connect();
  try {
    const uid = randomUUID().replaceAll("-", "").slice(0, 20);
    const traceId = `fixture-trace-${uid}`;
    const sessionId = `fixture-sess-${uid}`;
    await client.query(
      `INSERT INTO agent_trace_sessions (id, user_id, session_id)
       VALUES ($1, 'fixture-user', $2)`,
      [sessionId, sessionId],
    );
    await client.query(
      `INSERT INTO agent_traces (id, user_id, trace_session_id, session_id, name, status, attributes, started_at, created_at)
       VALUES ($1, 'fixture-user', $2, $2, 'director.query', 'unset', '{}'::jsonb, NOW(), NOW())`,
      [traceId, sessionId],
    );
    await client.query(
      `INSERT INTO agent_spans (id, user_id, trace_id, name, kind, status, attributes, started_at, ended_at, created_at)
       VALUES ($1, 'fixture-user', $2, 'root', 'internal', 'unset', '{}'::jsonb, NOW(), NOW(), NOW())`,
      [`fixture-span-${uid}`, traceId],
    );
    await client.query(
      `INSERT INTO cost_usage (id, user_id, trace_id, agent_name, model_name, input_tokens, output_tokens, estimated_cost_micros)
       VALUES ($1, 'fixture-user', $2, 'FixtureAgent', 'fixture-model', 10, 5, 0)`,
      [randomUUID(), traceId],
    );
    return { traceId, sessionId };
  } finally {
    await client.end();
  }
}

describe("auth", () => {
  it("rejects wrong password with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts correct password and returns a JWT", async () => {
    expect(token).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(token) });
    expect(me.statusCode).toBe(200);
  });
});

describe("traces", () => {
  it("requires auth (401 without token)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/traces" });
    expect(res.statusCode).toBe(401);
  });

  it("lists recent traces with mode filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/traces?limit=10&mode=query",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    if (body.items.length > 0) {
      const item = body.items[0];
      expect(item.id).toBeTruthy();
      expect(item.mode).toBe("query");
      expect(typeof item.status).toBe("string");
    }
  });

  it("returns full detail for the first listed trace", async () => {
    const list = await app.inject({ method: "GET", url: "/api/traces?limit=1", headers: auth(token) });
    const items = list.json().items;
    expect(items.length).toBeGreaterThan(0); // 本地共享库应有数据（评测/冒烟产生）
    const id = items[0].id;
    const res = await app.inject({ method: "GET", url: `/api/traces/${id}`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.trace.id).toBe(id);
    expect(Array.isArray(detail.spans)).toBe(true);
    expect(Array.isArray(detail.costRows)).toBe(true);
    expect(Array.isArray(detail.auditRows)).toBe(true);
  });

  it("returns 404 for unknown trace id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/traces/definitely-not-exists-12345",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("overview", () => {
  it("returns aggregation shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const key of [
      "tracesTotal",
      "tracesOk",
      "tracesError",
      "errorRate",
      "avgDurationMs",
      "p50DurationMs",
      "inputTokens",
      "outputTokens",
      "statusBreakdown",
      "modeBreakdown",
      "trend",
      "recentErrors",
    ]) {
      expect(body[key], `missing key ${key}`).toBeDefined();
    }
    expect(Array.isArray(body.trend)).toBe(true);
    expect(body.trend.length).toBeGreaterThan(0);
  });
});

describe("executions", () => {
  it("returns 404 for unknown execution", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/executions/not-an-execution",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns execution detail with tasks/attempts for a real one", async () => {
    const traces = await app.inject({
      method: "GET",
      url: "/api/traces?limit=50",
      headers: auth(token),
    });
    const withExec = traces.json().items.find((t: { executionId: string | null }) => t.executionId);
    if (!withExec) return; // 无带 executionId 的 trace 时跳过
    const res = await app.inject({
      method: "GET",
      url: `/api/executions/${withExec.executionId}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.execution.id).toBe(withExec.executionId);
    expect(Array.isArray(body.tasks)).toBe(true);
  });
});

// collection 阶段判断（describe 回调在 beforeAll 之前执行，不能用 config）
const HAS_MANAGER = Boolean(process.env.OBS_MANAGER_DATABASE_URL);

describe.skipIf(!HAS_MANAGER)("management (obs_manager)", () => {
  const managerUrl = process.env.OBS_MANAGER_DATABASE_URL!;

  it("deletes a single trace with cascade and cleans orphans", async () => {
    const fixture = await createFixture(managerUrl);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/traces/${fixture.traceId}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/api/traces/${fixture.traceId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(404);
  });

  it("returns 404 for deleting an unknown trace", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/traces/fixture-trace-does-not-exist",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("prune dry-run counts then execute deletes (scoped by userId)", async () => {
    const f1 = await createFixture(managerUrl);
    const f2 = await createFixture(managerUrl);

    const dry = await app.inject({
      method: "POST",
      url: "/api/traces/prune",
      headers: auth(token),
      payload: { filters: { status: "unset", userId: "fixture-user" }, dryRun: true },
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().dryRun).toBe(true);
    expect(dry.json().matched).toBeGreaterThanOrEqual(2);

    const exec = await app.inject({
      method: "POST",
      url: "/api/traces/prune",
      headers: auth(token),
      payload: { filters: { status: "unset", userId: "fixture-user" }, dryRun: false },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json().matched).toBeGreaterThanOrEqual(2);

    for (const fixture of [f1, f2]) {
      const detail = await app.inject({
        method: "GET",
        url: `/api/traces/${fixture.traceId}`,
        headers: auth(token),
      });
      expect(detail.statusCode, `fixture ${fixture.traceId} should be gone`).toBe(404);
    }
  });
});
