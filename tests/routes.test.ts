import "dotenv/config";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { createDatabase } from "../src/server/db.js";

let app: FastifyInstance;
let token = "";

beforeAll(async () => {
  const config = loadConfig();
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
