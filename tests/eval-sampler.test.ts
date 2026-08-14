import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/server/db.js";
import {
  classifySource,
  EvalSamplerService,
} from "../src/server/services/evalSamplerService.js";

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

const traceRow = {
  trace_id: "tr-1",
  execution_id: "ex-1",
  user_id: "u1",
  session_id: "s1",
  mode: "query",
  requirement: "H002 焰星的职业是什么？",
  output: "焰星·玲：法师，火元素。",
  attributes: {},
  started_at: "2026-08-13T01:00:00Z",
  span_count: 3,
  signal_count: 0,
};

describe("EvalSamplerService (flywheel 03-P4)", () => {
  it("is disabled without manager db", () => {
    const svc = new EvalSamplerService(fakeDb(), undefined);
    expect(svc.enabled).toBe(false);
  });

  it("runSampling inserts candidates via manager and dedupes by (user, question)", async () => {
    const reader = fakeDb([traceRow]);
    const manager = fakeDb([]); // 去重查询返回空 → 全部可采
    const svc = new EvalSamplerService(reader, manager, { windowHours: 24, maxPerRun: 10 });
    const result = await svc.runSampling(new Date("2026-08-13T12:00:00Z"));

    expect(result.sampled).toBe(1);
    expect(result.bySource.tool_chain).toBe(1);
    const insert = manager.calls.find((c) => c.sql.includes("INSERT INTO obs_metrics.eval_candidates"));
    expect(insert).toBeDefined();
    expect(insert!.params[6]).toBe("H002 焰星的职业是什么？"); // question
    expect(insert!.params[8]).toBe("tool_chain"); // source
    expect(insert!.sql).toContain("'pending'"); // status 为 SQL 字面量
    expect(String(insert!.params[9]).length).toBeGreaterThan(10); // created_at ISO

    // 去重：manager 返回已存在 → 不再插入
    const dupManager = fakeDb([{ exists: 1 }]);
    const svc2 = new EvalSamplerService(reader, dupManager, {});
    const dupResult = await svc2.runSampling(new Date("2026-08-13T12:00:00Z"));
    expect(dupResult.sampled).toBe(0);
    const dupInsert = dupManager.calls.find((c) => c.sql.includes("INSERT INTO obs_metrics.eval_candidates"));
    expect(dupInsert).toBeUndefined();
  });

  it("skips executions without a requirement and caps per run", async () => {
    const rows = [
      traceRow,
      { ...traceRow, trace_id: "tr-2", requirement: "" },
      { ...traceRow, trace_id: "tr-3", requirement: "问题三", span_count: 0 },
    ];
    const manager = fakeDb([]);
    const svc = new EvalSamplerService(fakeDb(rows), manager, { maxPerRun: 2 });
    const result = await svc.runSampling(new Date("2026-08-13T12:00:00Z"));
    expect(result.sampled).toBe(2); // tr-1 + tr-3（tr-2 无 requirement 被跳过）
  });

  it("listCandidates maps rows and filters by status", async () => {
    const rows = [
      {
        id: "cand_1",
        trace_id: "tr-1",
        execution_id: "ex-1",
        user_id: "u1",
        session_id: "s1",
        mode: "query",
        question: "Q1",
        answer: "A1",
        source: "plain_query",
        status: "pending",
        created_at: "2026-08-13T01:00:00Z",
        exported_at: null,
      },
    ];
    const reader = fakeDb(rows);
    const svc = new EvalSamplerService(reader, undefined);
    const listed = await svc.listCandidates({ status: "pending" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.question).toBe("Q1");
    const statusCall = reader.calls.find((c) => c.sql.includes("WHERE status"));
    expect(statusCall).toBeDefined();
  });

  it("markStatus returns false without manager db and updates with it", async () => {
    const svc = new EvalSamplerService(fakeDb(), undefined);
    expect(await svc.markStatus("cand_1", "exported", "admin")).toBe(false);

    const manager = fakeDb([{ id: "cand_1" }]);
    const svc2 = new EvalSamplerService(fakeDb(), manager);
    expect(await svc2.markStatus("cand_1", "exported", "admin")).toBe(true);
    const update = manager.calls.find((c) => c.sql.includes("UPDATE obs_metrics.eval_candidates"));
    expect(update!.params[1]).toBe("exported");
  });

  it("exportCandidates returns eval-compatible payload with trace provenance", async () => {
    const rows = [
      {
        id: "cand_1",
        trace_id: "tr-1",
        execution_id: "ex-1",
        user_id: "u1",
        session_id: "s1",
        mode: "query",
        question: "Q1",
        answer: "A1",
        source: "faq_miss",
        status: "pending",
        created_at: "2026-08-13T01:00:00Z",
        exported_at: null,
      },
    ];
    const svc = new EvalSamplerService(fakeDb(rows), undefined);
    const payload = await svc.exportCandidates();
    expect(payload.candidates[0]).toMatchObject({
      question: "Q1",
      answer: "A1",
      traceId: "tr-1",
      source: "faq_miss",
    });
  });

  it("classifySource prefers user signals, then faq markers, then tool chain, then plain", () => {
    expect(classifySource({}, 0, 1)).toBe("user_signal");
    expect(classifySource({ faqHit: false }, 0, 0)).toBe("faq_miss");
    expect(classifySource({ faq: "miss" }, 5, 0)).toBe("faq_miss");
    expect(classifySource({}, 2, 0)).toBe("tool_chain");
    expect(classifySource(null, 1, 0)).toBe("plain_query");
    expect(classifySource("no markers", 0, 0)).toBe("plain_query");
  });

  it("user_signal source is sampled when the trace has signal events", async () => {
    const rows = [{ ...traceRow, trace_id: "tr-sig", signal_count: 2 }];
    const manager = fakeDb([]);
    const svc = new EvalSamplerService(fakeDb(rows), manager, {});
    const result = await svc.runSampling(new Date("2026-08-13T12:00:00Z"));
    expect(result.sampled).toBe(1);
    expect(result.bySource.user_signal).toBe(1);
    const insert = manager.calls.find((c) => c.sql.includes("INSERT INTO obs_metrics.eval_candidates"));
    expect(insert!.params[8]).toBe("user_signal");
  });

  it("logs the run summary", async () => {
    const log = vi.fn();
    const svc = new EvalSamplerService(fakeDb([traceRow]), fakeDb([]), { log });
    await svc.runSampling(new Date("2026-08-13T12:00:00Z"));
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("sampled 1"));
  });
});
