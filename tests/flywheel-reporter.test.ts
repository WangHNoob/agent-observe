import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/server/db.js";
import { FlywheelReporter, type FlywheelThresholds } from "../src/server/services/flywheelReporter.js";

const THRESHOLDS: FlywheelThresholds = {
  errorRate: 0.5,
  minErrors: 3,
  minTimeouts: 3,
  minToolErrors: 3,
  costThresholdMicros: 5_000_000,
  dedupeWindowHours: 24,
};

type QueryCall = { sql: string; params: unknown[] };

/** 按 SQL 特征返回对应规则的行（真实行为由各规则 SQL 驱动）。 */
function fakeDb(overrides: { reported?: boolean } = {}): Database & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql: String(sql), params });
      const s = String(sql);
      if (s.includes("flywheel_reports") && s.includes("SELECT")) {
        return { rows: overrides.reported ? [{ 1: 1 }] : [], rowCount: overrides.reported ? 1 : 0 } as never;
      }
      if (s.includes("md5(")) {
        // R1：同需求 3 次执行 2 失败（≥minErrors=3 不满足 → 无信号）与 5 次 4 失败（满足）
        return {
          rows: [
            { req_hash: "hash-a", requirement: "需求A", n: 5, error_n: 4, latest_execution_id: "exec-a", latest_started_at: new Date() },
          ],
          rowCount: 1,
        } as never;
      }
      if (s.includes("timed_out") && s.includes("FROM executions")) {
        // R2：3 次超时（满足阈值）
        return {
          rows: [{ n: 3, requirement: "需求B", latest_execution_id: "exec-b" }],
          rowCount: 1,
        } as never;
      }
      if (s.includes("agent_spans")) {
        // R3：工具 kb_search 失败 4 次
        return {
          rows: [{ tool_name: "kb_search", n: 4, latest_trace_id: "trace-c" }],
          rowCount: 1,
        } as never;
      }
      if (s.includes("cost_total")) {
        // R4：24h 成本超阈值
        return {
          rows: [{ total_micros: 6_000_000, execution_id: "exec-d", request_payload: { requirement: "需求D" }, exec_micros: 2_000_000 }],
          rowCount: 1,
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
  };
}

function managerDb(overrides: { reported?: boolean } = {}): Database & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql: String(sql), params });
      const s = String(sql);
      if (s.includes("flywheel_reports") && s.includes("SELECT")) {
        return { rows: overrides.reported ? [{ 1: 1 }] : [], rowCount: overrides.reported ? 1 : 0 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
  };
}

describe("FlywheelReporter", () => {
  it("is disabled without kh url/token", async () => {
    const svc = new FlywheelReporter(fakeDb(), managerDb(), {
      khUrl: undefined,
      khToken: undefined,
      dryRun: true,
      projectId: "default_project",
      thresholds: THRESHOLDS,
    });
    expect(svc.enabled).toBe(false);
    const result = await svc.runScheduledEvaluation();
    expect(result).toEqual({ collected: 0, reported: 0, skipped: 0 });
  });

  it("dry-run collects signals but does not report or persist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mgr = managerDb();
      const svc = new FlywheelReporter(fakeDb(), mgr, {
        khUrl: "https://kh.example",
        khToken: "token",
        dryRun: true,
        projectId: "default_project",
        thresholds: THRESHOLDS,
      });
      const result = await svc.runScheduledEvaluation();
      expect(result.collected).toBe(4); // R1+R2+R3+R4 各一
      expect(result.reported).toBe(0);
      expect(result.skipped).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mgr.calls.filter((c) => c.sql.includes("INSERT INTO obs_metrics.flywheel_reports"))).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports signals via kh /api/mcp/query and persists dedupe keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mgr = managerDb();
      const svc = new FlywheelReporter(fakeDb(), mgr, {
        khUrl: "https://kh.example/",
        khToken: "token",
        dryRun: false,
        projectId: "default_project",
        thresholds: THRESHOLDS,
      });
      const result = await svc.runScheduledEvaluation();
      expect(result.reported).toBe(4);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // 验证上报载荷（R1 用 kb_report_gap + requirement）
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      const gapCalls = calls.filter(([, init]) => String(init.body).includes('"kb_report_gap"'));
      expect(gapCalls.length).toBeGreaterThan(0);
      const firstBody = JSON.parse(String(gapCalls[0]![1].body));
      expect(firstBody.payload.query).toBe("需求A");
      expect(firstBody.payload.projectId).toBe("default_project");
      expect(firstBody.payload.agentRole).toBe("obs-flywheel");
      // 幂等键落库 4 条
      const inserts = mgr.calls.filter((c) => c.sql.includes("INSERT INTO obs_metrics.flywheel_reports"));
      expect(inserts).toHaveLength(4);
      expect(String(inserts[0]!.params[0])).toMatch(/^error_rate::/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips already-reported signals within dedupe window", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mgr = managerDb({ reported: true });
      const svc = new FlywheelReporter(fakeDb(), mgr, {
        khUrl: "https://kh.example",
        khToken: "token",
        dryRun: false,
        projectId: "default_project",
        thresholds: THRESHOLDS,
      });
      const result = await svc.runScheduledEvaluation();
      expect(result.skipped).toBe(4);
      expect(result.reported).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps running when a report request fails (guardrail)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const svc = new FlywheelReporter(fakeDb(), managerDb(), {
        khUrl: "https://kh.example",
        khToken: "bad-token",
        dryRun: false,
        projectId: "default_project",
        thresholds: THRESHOLDS,
      });
      const result = await svc.runScheduledEvaluation();
      expect(result.reported).toBe(0); // 全部失败但不抛出
      expect(result.collected).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
