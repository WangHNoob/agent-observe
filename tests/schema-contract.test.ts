import { describe, expect, it } from "vitest";
import type { Database } from "../src/server/db.js";
import {
  loadSchemaContract,
  verifySchemaContract,
  type SchemaContract,
} from "../src/server/schemaContract.js";

/** 由契约生成"完全匹配"的 information_schema 行。 */
function perfectRows(contract: SchemaContract): Array<{
  table_name: string;
  column_name: string;
  data_type: string;
}> {
  const rows: Array<{ table_name: string; column_name: string; data_type: string }> = [];
  for (const t of contract.tables) {
    for (const c of t.columns) {
      // 用契约 typeFamilies 的第一个成员作为该族的实际 PG 类型
      const members = contract.typeFamilies[c.type];
      rows.push({
        table_name: t.table,
        column_name: c.name,
        data_type: members?.[0] ?? c.type,
      });
    }
  }
  return rows;
}

function fakeDb(rows: Array<{ table_name: string; column_name: string; data_type: string }>): Database {
  return {
    async query() {
      return { rows, rowCount: rows.length } as never;
    },
  };
}

const contract = loadSchemaContract();

describe("verifySchemaContract", () => {
  it("returns ok when all tables/columns/types match", async () => {
    const report = await verifySchemaContract(fakeDb(perfectRows(contract)), contract);
    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(0);
    expect(report.checkedTables).toBe(contract.tables.length);
  });

  it("detects a missing table", async () => {
    const rows = perfectRows(contract).filter((r) => r.table_name !== "agent_spans");
    const report = await verifySchemaContract(fakeDb(rows), contract);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "missing_table", table: "agent_spans" }),
    );
  });

  it("detects a missing column", async () => {
    const rows = perfectRows(contract).filter(
      (r) => !(r.table_name === "agent_traces" && r.column_name === "started_at"),
    );
    const report = await verifySchemaContract(fakeDb(rows), contract);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "missing_column", table: "agent_traces", column: "started_at" }),
    );
  });

  it("detects a type-family change (jsonb -> text would be text vs jsonb mismatch)", async () => {
    const rows = perfectRows(contract).map((r) =>
      r.table_name === "agent_traces" && r.column_name === "attributes"
        ? { ...r, data_type: "text" }
        : r,
    );
    const report = await verifySchemaContract(fakeDb(rows), contract);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "type_mismatch", table: "agent_traces", column: "attributes" }),
    );
  });

  it("accepts any member of the same type family (integer vs bigint)", async () => {
    const rows = perfectRows(contract).map((r) =>
      r.table_name === "cost_usage" && r.column_name === "input_tokens"
        ? { ...r, data_type: "bigint" }
        : r,
    );
    const report = await verifySchemaContract(fakeDb(rows), contract);
    expect(report.ok).toBe(true);
  });
});
