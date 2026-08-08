import pg from "pg";

/** 只读数据库门面。所有查询均为 SELECT（连接串层面已强制 read-only，双保险）。 */
export interface Database {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export function createDatabase(databaseUrl: string): Database {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
  });
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });
  return {
    async query(sql, params) {
      return pool.query(sql, params);
    },
  };
}
