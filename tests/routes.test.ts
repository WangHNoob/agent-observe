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
    expect(detail.spansLite).toBe(true);
    expect(Array.isArray(detail.costRows)).toBe(true);
    expect(Array.isArray(detail.auditRows)).toBe(true);
    expect("executionSummary" in detail).toBe(true);

    if (detail.spans.length > 0) {
      const spanId = detail.spans[0].id;
      const spanRes = await app.inject({
        method: "GET",
        url: `/api/traces/${id}/spans/${spanId}`,
        headers: auth(token),
      });
      expect(spanRes.statusCode).toBe(200);
      const span = spanRes.json();
      expect(span.id).toBe(spanId);
      expect(span.attributes).toBeTypeOf("object");
    }
  });

  it("returns 404 for unknown span", async () => {
    const list = await app.inject({ method: "GET", url: "/api/traces?limit=1", headers: auth(token) });
    const id = list.json().items[0]?.id;
    if (!id) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/traces/${id}/spans/definitely-not-a-span`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
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

describe("meta", () => {
  it("returns retention flags without heavy aggregation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/meta", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.retentionDays).toBe("number");
    expect(typeof body.pruneAvailable).toBe("boolean");
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    expect(res.statusCode).toBe(401);
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
      url: `/api/executions/${withExec.executionId}?include=primaryTrace`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.execution.id).toBe(withExec.executionId);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.primaryTrace == null || body.primaryTrace.trace.id).toBeTruthy();
    if (body.primaryTrace) {
      expect(body.primaryTrace.spansLite).toBe(true);
    }
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

describe("sessions", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("lists sessions with rollups", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions?limit=5",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    if (body.items.length === 0) return; // 空库守卫
    const item = body.items[0];
    for (const key of ["id", "mode", "status", "requirement", "traceCount", "executionCount", "inputTokens", "costMicros"]) {
      expect(item).toHaveProperty(key);
    }
    expect(typeof item.costMicros).toBe("string");
  });

  it("filters by mode and tolerates invalid/oversized params", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions?mode=query&limit=500",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    for (const item of res.json().items) {
      expect(item.mode).toBe("query");
    }
  });

  it("filters by q against requirement", async () => {
    const all = await app.inject({
      method: "GET",
      url: "/api/sessions?limit=5",
      headers: auth(token),
    });
    const first = all.json().items[0];
    if (!first) return; // 空库守卫
    const frag = String(first.requirement).slice(0, 8);
    if (!frag) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions?q=${encodeURIComponent(frag)}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(1);
  });

  it("returns session detail with per-trace rollups, traceIds and totals", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/sessions?limit=1",
      headers: auth(token),
    });
    const first = list.json().items[0];
    if (!first) return; // 空库守卫
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${first.id}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.id).toBe(first.id);
    expect(body.totals).toHaveProperty("inputTokens");
    expect(body.totals).toHaveProperty("costMicros");
    for (const t of body.traces) {
      expect(t).toHaveProperty("inputTokens");
      expect(t).toHaveProperty("costMicros");
    }
    for (const e of body.executions) {
      expect(Array.isArray(e.traceIds)).toBe(true);
    }
  });

  it("returns 404 for unknown session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/no-such-session-000000000",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

// 回归：会话列表 traceCount 曾按 join cost_usage 的行数 fanout（一次对话多少次
// LLM 调用就被当成多少个 trace）。fixture：1 会话 + 1 trace + 3 cost 行 → traceCount 必须是 1。
describe.skipIf(!HAS_MANAGER)("sessions list traceCount (cost fanout regression)", () => {
  const managerUrl = process.env.OBS_MANAGER_DATABASE_URL!;
  const uid = randomUUID().replaceAll("-", "").slice(0, 20);
  const sessionId = `fixture-sess-${uid}`;
  const traceId = `fixture-trace-${uid}`;
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: managerUrl });
    await client.connect();
    await client.query(
      `INSERT INTO agent_trace_sessions (id, user_id, session_id)
       VALUES ($1, 'fixture-user', $1)`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO sessions (id, user_id, requirement, mode, role, status)
       VALUES ($1, 'fixture-user', $2, 'query', 'tester', 'completed')`,
      [sessionId, `traceCount regression ${sessionId}`],
    );
    await client.query(
      `INSERT INTO agent_traces (id, user_id, trace_session_id, session_id, name, status, attributes, started_at, created_at)
       VALUES ($1, 'fixture-user', $2, $2, 'director.query', 'ok', '{}'::jsonb, NOW(), NOW())`,
      [traceId, sessionId],
    );
    for (let i = 0; i < 3; i++) {
      await client.query(
        `INSERT INTO cost_usage (id, user_id, trace_id, agent_name, model_name, input_tokens, output_tokens, estimated_cost_micros)
         VALUES ($1, 'fixture-user', $2, 'FixtureAgent', 'fixture-model', 10, 5, 0)`,
        [randomUUID(), traceId],
      );
    }
  });

  afterAll(async () => {
    if (!client) return;
    // 自建自删，逆依赖顺序清理（sessions 行是 design-agent 业务表，只动 fixture id）
    await client.query(`DELETE FROM cost_usage WHERE trace_id = $1`, [traceId]);
    await client.query(`DELETE FROM agent_spans WHERE trace_id = $1`, [traceId]);
    await client.query(`DELETE FROM agent_traces WHERE id = $1`, [traceId]);
    await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    await client.query(`DELETE FROM agent_trace_sessions WHERE id = $1`, [sessionId]);
    await client.end();
  });

  it("counts distinct traces, not joined cost rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions?q=${encodeURIComponent(sessionId)}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const hit = res.json().items.find((s: { id: string }) => s.id === sessionId);
    expect(hit).toBeDefined();
    expect(hit.traceCount).toBe(1); // 修复前：3（fanout）
    expect(hit.executionCount).toBe(0);
    expect(hit.inputTokens).toBe(30);
    expect(hit.outputTokens).toBe(15);
  });
});

// viewer 只读门禁：DELETE 在 preHandler 即被拒（无需真实 fixture 行）
const HAS_VIEWER = Boolean(process.env.OBS_VIEWER_PASSWORD);

describe.skipIf(!HAS_VIEWER)("viewer role gating", () => {
  it("logs in as viewer and rejects DELETE with 403 Admin only", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: process.env.OBS_VIEWER_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().role).toBe("viewer");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/traces/fixture-trace-does-not-exist",
      headers: auth(login.json().token),
    });
    expect(del.statusCode).toBe(403);
    expect(del.json().error).toBe("Admin only");
  });
});
