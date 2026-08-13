import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { Database } from "./db.js";

/**
 * schema 契约校验：agent-observe 依赖 design-agent 共享库的表结构。
 *
 * 契约声明在根目录 schema-contract.json（含 schemaVersion），与 design-agent
 * 的 drizzle 迁移同步维护。本模块在启动与定时复检时对 information_schema
 * 做对比，发现漂移（缺表/缺列/类型族变化）即报告——避免"两边改列静默错乱"。
 */

export interface ContractColumn {
  name: string;
  /** 类型族（text/timestamptz/jsonb/numeric/boolean/uuid），见契约文件 typeFamilies */
  type: string;
}

export interface ContractTable {
  table: string;
  columns: ContractColumn[];
}

export interface SchemaContract {
  schemaVersion: number;
  typeFamilies: Record<string, string[]>;
  tables: ContractTable[];
}

export interface SchemaContractIssue {
  kind: "missing_table" | "missing_column" | "type_mismatch";
  table: string;
  column?: string;
  expected: string;
  actual: string;
}

export interface SchemaContractReport {
  ok: boolean;
  schemaVersion: number;
  checkedTables: number;
  issues: SchemaContractIssue[];
}

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = resolve(here, "../../schema-contract.json");

export function loadSchemaContract(path = CONTRACT_PATH): SchemaContract {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as SchemaContract;
}

/** 把 information_schema.data_type 归入契约类型族；未知类型返回原值（按 text 处理会误报，故单独标记）。 */
function familyOf(dataType: string, families: Record<string, string[]>): string {
  const dt = dataType.toLowerCase();
  for (const [family, members] of Object.entries(families)) {
    if (members.includes(dt)) return family;
  }
  return dt;
}

/**
 * 校验共享库 schema 是否满足契约。
 * 只读查询（information_schema），任何角色可执行。
 */
export async function verifySchemaContract(
  db: Database,
  contract: SchemaContract,
): Promise<SchemaContractReport> {
  const issues: SchemaContractIssue[] = [];

  const tableNames = contract.tables.map((t) => t.table);
  const result = await db.query<pg.QueryResultRow>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tableNames],
  );

  const actualByTable = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    const table = String(row.table_name ?? "");
    const column = String(row.column_name ?? "");
    const dataType = String(row.data_type ?? "");
    if (!table || !column) continue;
    let cols = actualByTable.get(table);
    if (!cols) {
      cols = new Map();
      actualByTable.set(table, cols);
    }
    cols.set(column, dataType);
  }

  for (const t of contract.tables) {
    const actualCols = actualByTable.get(t.table);
    if (!actualCols) {
      issues.push({
        kind: "missing_table",
        table: t.table,
        expected: "table exists",
        actual: "missing",
      });
      continue;
    }
    for (const c of t.columns) {
      const actualType = actualCols.get(c.name);
      if (actualType === undefined) {
        issues.push({
          kind: "missing_column",
          table: t.table,
          column: c.name,
          expected: c.type,
          actual: "missing",
        });
        continue;
      }
      const expectedFamily = contract.typeFamilies[c.type] ? c.type : c.type;
      const actualFamily = familyOf(actualType, contract.typeFamilies);
      if (expectedFamily !== actualFamily) {
        issues.push({
          kind: "type_mismatch",
          table: t.table,
          column: c.name,
          expected: expectedFamily,
          actual: actualFamily,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    schemaVersion: contract.schemaVersion,
    checkedTables: contract.tables.length,
    issues,
  };
}
