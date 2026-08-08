import type pg from "pg";
import type { Database } from "../db.js";

export interface ExecutionTask {
  id: string;
  taskKey: string;
  name: string;
  agentName: string | null;
  status: string;
  dependencies: unknown;
  position: number;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  attempts: {
    attemptNumber: number;
    status: string;
    errorClass: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

export interface ExecutionDetail {
  execution: {
    id: string;
    userId: string;
    sessionId: string;
    idempotencyKey: string;
    status: string;
    requestPayload: Record<string, unknown>;
    planPayload: Record<string, unknown> | null;
    resultPayload: Record<string, unknown> | null;
    errorClass: string | null;
    errorMessage: string | null;
    deadlineAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  };
  tasks: ExecutionTask[];
}

export class ExecutionService {
  constructor(private readonly db: Database) {}

  async getExecution(executionId: string): Promise<ExecutionDetail | null> {
    const execResult = await this.db.query(
      `SELECT id, user_id AS "userId", session_id AS "sessionId",
              idempotency_key AS "idempotencyKey", status,
              request_payload AS "requestPayload", plan_payload AS "planPayload",
              result_payload AS "resultPayload", error_class AS "errorClass",
              error_message AS "errorMessage", deadline_at AS "deadlineAt",
              started_at AS "startedAt", completed_at AS "completedAt",
              created_at AS "createdAt"
       FROM executions WHERE id = $1`,
      [executionId],
    );
    const row = execResult.rows[0] as pg.QueryResultRow | undefined;
    if (!row) return null;

    const [taskResult, attemptResult] = await Promise.all([
      this.db.query(
        `SELECT id, task_key AS "taskKey", name, agent_name AS "agentName",
                status, dependencies, position, error_class AS "errorClass",
                error_message AS "errorMessage", started_at AS "startedAt",
                completed_at AS "completedAt"
         FROM execution_tasks WHERE execution_id = $1
         ORDER BY position, created_at`,
        [executionId],
      ),
      this.db.query(
        `SELECT task_id AS "taskId", attempt_number AS "attemptNumber", status,
                error_class AS "errorClass", error_code AS "errorCode",
                error_message AS "errorMessage", started_at AS "startedAt",
                finished_at AS "finishedAt"
         FROM execution_attempts WHERE execution_id = $1
         ORDER BY started_at`,
        [executionId],
      ),
    ]);

    const attemptsByTask = new Map<string, ExecutionTask["attempts"]>();
    for (const r of attemptResult.rows) {
      const list = attemptsByTask.get(r.taskId as string) ?? [];
      list.push({
        attemptNumber: Number(r.attemptNumber),
        status: r.status as string,
        errorClass: (r.errorClass as string | null) ?? null,
        errorCode: (r.errorCode as string | null) ?? null,
        errorMessage: (r.errorMessage as string | null) ?? null,
        startedAt: r.startedAt as string,
        finishedAt: (r.finishedAt as string | null) ?? null,
      });
      attemptsByTask.set(r.taskId as string, list);
    }

    return {
      execution: {
        id: row.id as string,
        userId: row.userId as string,
        sessionId: row.sessionId as string,
        idempotencyKey: row.idempotencyKey as string,
        status: row.status as string,
        requestPayload: (row.requestPayload as Record<string, unknown>) ?? {},
        planPayload: (row.planPayload as Record<string, unknown> | null) ?? null,
        resultPayload: (row.resultPayload as Record<string, unknown> | null) ?? null,
        errorClass: (row.errorClass as string | null) ?? null,
        errorMessage: (row.errorMessage as string | null) ?? null,
        deadlineAt: (row.deadlineAt as string | null) ?? null,
        startedAt: (row.startedAt as string | null) ?? null,
        completedAt: (row.completedAt as string | null) ?? null,
        createdAt: row.createdAt as string,
      },
      tasks: taskResult.rows.map((r) => ({
        id: r.id as string,
        taskKey: r.taskKey as string,
        name: r.name as string,
        agentName: (r.agentName as string | null) ?? null,
        status: r.status as string,
        dependencies: r.dependencies as unknown,
        position: Number(r.position ?? 0),
        errorClass: (r.errorClass as string | null) ?? null,
        errorMessage: (r.errorMessage as string | null) ?? null,
        startedAt: (r.startedAt as string | null) ?? null,
        completedAt: (r.completedAt as string | null) ?? null,
        attempts: attemptsByTask.get(r.id as string) ?? [],
      })),
    };
  }
}
