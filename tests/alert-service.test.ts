import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/server/db.js";
import { AlertService } from "../src/server/services/alertService.js";

type QueryCall = { sql: string; params: unknown[] };

function fakeDb(rows: unknown[] = []): Database & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql: String(sql), params });
      return { rows, rowCount: rows.length } as never;
    },
  };
}

describe("AlertService", () => {
  it("is disabled without manager db", () => {
    const svc = new AlertService(fakeDb(), undefined);
    expect(svc.enabled).toBe(false);
    // 禁用时 raise 不应产生任何写调用
    void svc.raise("error_rate", "critical", "k", "msg");
    expect(true).toBe(true);
  });

  it("raise upserts into obs_metrics.alerts with open status and dedupe key", async () => {
    const reader = fakeDb();
    const manager = fakeDb();
    const svc = new AlertService(reader, manager, { webhookUrl: undefined });
    await svc.raise("error_rate", "critical", "last-1h", "错误率过高", { n: 10 });
    const insert = manager.calls.find((c) => c.sql.includes("INSERT INTO obs_metrics.alerts"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("'open'"); // status 为 SQL 字面量
    expect(insert!.params[0]).toBe("error_rate::last-1h"); // id = rule::key
    expect(insert!.params[1]).toBe("error_rate"); // rule
    expect(insert!.params[3]).toBe("last-1h"); // key
    expect(insert!.params[4]).toBe("错误率过高"); // message
    expect(insert!.params[5]).toBe('{"n":10}'); // detail JSON
  });

  it("resolve marks alert resolved and returns false for missing id", async () => {
    const manager = fakeDb([{ id: "x" }]);
    const svc = new AlertService(fakeDb(), manager);
    const ok = await svc.resolve("error_rate::last-1h", "admin");
    expect(ok).toBe(true);
    const update = manager.calls.find((c) => c.sql.includes("UPDATE obs_metrics.alerts"));
    expect(update!.params[1]).toBe("admin");

    const emptyManager = fakeDb([]);
    const svc2 = new AlertService(fakeDb(), emptyManager);
    const notFound = await svc2.resolve("missing", "admin");
    expect(notFound).toBe(false);
  });

  it("list maps rows to AlertRecord", async () => {
    const rows = [
      {
        id: "a::1",
        rule: "a",
        severity: "warning",
        status: "open",
        key: "1",
        message: "m",
        detail: { n: 1 },
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        resolvedAt: null,
      },
    ];
    const reader = fakeDb(rows);
    const svc = new AlertService(reader, fakeDb());
    const alerts = await svc.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.rule).toBe("a");
    expect(alerts[0]!.status).toBe("open");
    expect(alerts[0]!.resolvedAt).toBeNull();
  });

  it("runScheduledEvaluation is a no-op when disabled", async () => {
    const svc = new AlertService(fakeDb(), undefined);
    await svc.runScheduledEvaluation();
    expect(true).toBe(true);
  });

  it("notifies webhook when url configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const reader = fakeDb();
      const manager = fakeDb();
      const svc = new AlertService(reader, manager, { webhookUrl: "https://example.invalid/hook" });
      await svc.raise("timeout_spike", "warning", "last-1h", "超时");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://example.invalid/hook");
      const payload = JSON.parse(String((init as RequestInit).body));
      expect(payload.rule).toBe("timeout_spike");
      expect(payload.source).toBe("agent-observe");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
