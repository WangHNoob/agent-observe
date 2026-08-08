import type pg from "pg";
import type { Database } from "../db.js";

export interface SessionDetail {
  session: {
    id: string;
    userId: string;
    requirement: string;
    mode: string;
    role: string;
    status: string;
    output: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  };
  traces: {
    id: string;
    name: string;
    status: string;
    executionId: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
  }[];
  executions: {
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
  }[];
}

export class SessionService {
  constructor(private readonly db: Database) {}

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const sessionResult = await this.db.query(
      `SELECT id, user_id AS "userId", requirement, mode, role, status,
              output, error, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const row = sessionResult.rows[0] as pg.QueryResultRow | undefined;
    if (!row) return null;

    const [traces, executions] = await Promise.all([
      this.db.query(
        `SELECT id, name, status, execution_id AS "executionId",
                started_at AS "startedAt", ended_at AS "endedAt",
                EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000 AS "durationMs"
         FROM agent_traces WHERE session_id = $1
         ORDER BY started_at DESC`,
        [sessionId],
      ),
      this.db.query(
        `SELECT id, status, created_at AS "createdAt", completed_at AS "completedAt"
         FROM executions WHERE session_id = $1
         ORDER BY created_at DESC`,
        [sessionId],
      ),
    ]);

    return {
      session: {
        id: row.id as string,
        userId: row.userId as string,
        requirement: row.requirement as string,
        mode: row.mode as string,
        role: row.role as string,
        status: row.status as string,
        output: (row.output as string | null) ?? null,
        error: (row.error as string | null) ?? null,
        createdAt: row.createdAt as string,
        updatedAt: row.updatedAt as string,
      },
      traces: traces.rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        status: r.status as string,
        executionId: (r.executionId as string | null) ?? null,
        startedAt: r.startedAt as string,
        endedAt: (r.endedAt as string | null) ?? null,
        durationMs: r.durationMs != null ? Number(r.durationMs) : null,
      })),
      executions: executions.rows.map((r) => ({
        id: r.id as string,
        status: r.status as string,
        createdAt: r.createdAt as string,
        completedAt: (r.completedAt as string | null) ?? null,
      })),
    };
  }
}
