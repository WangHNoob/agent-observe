# 建议索引（design-agent 共享库）

> 归属：这些索引作用于 **design-agent-ts** 的共享 PostgreSQL（`game_designer`），
> 应在 design-agent 的 `drizzle/*.sql` 迁移中落地，而不是在 agent-observe 侧执行
> （观测台只读，不拥有 schema 变更权）。

## 索引清单

| 表 | 索引 | 理由 | 优先级 |
|---|---|---|---|
| `agent_traces` | `(started_at DESC)` | trace 列表与 overview 按时间倒序分页/聚合 | 高 |
| `agent_traces` | `(execution_id)` | Execution 详情页按 executionId 找主 trace；metrics 聚合 JOIN | 高 |
| `agent_traces` | `(session_id)` | Session 详情页列出其 traces | 中 |
| `agent_spans` | `(trace_id, started_at)` | Trace 详情瀑布图按 traceId 全量取 span 并排序 | 高 |
| `cost_usage` | `(trace_id)` | trace 详情/列表聚合 cost | 高 |
| `audit_logs` | `(trace_id)` | trace 详情关联审计 | 中 |
| `executions` | `(session_id)` | Session 详情页列出 executions | 中 |
| `execution_tasks` | `(execution_id, position)` | Execution DAG 查询 | 中 |
| `execution_attempts` | `(execution_id)` | Execution 重试链查询 | 低 |

## 落地方式（design-agent 侧）

在 design-agent-ts 新增一个 drizzle 迁移文件，例如：

```sql
CREATE INDEX IF NOT EXISTS idx_agent_traces_started_at ON agent_traces (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_execution_id ON agent_traces (execution_id);
CREATE INDEX IF NOT EXISTS idx_agent_traces_session_id ON agent_traces (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_spans_trace_started ON agent_spans (trace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_cost_usage_trace_id ON cost_usage (trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_trace_id ON audit_logs (trace_id);
CREATE INDEX IF NOT EXISTS idx_executions_session_id ON executions (session_id);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_execution_position ON execution_tasks (execution_id, position);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_execution_id ON execution_attempts (execution_id);
```

## 注意事项

- `agent_traces(started_at DESC)` 与 TTL 清理（按 `started_at` 扫过期行）共用，收益双倍。
- 若表数据量小（< 10 万行）可先只建前三项，其余按观测台实际查询延迟决定。
- 索引变更会锁表（PG 12+ 支持 `CREATE INDEX CONCURRENTLY`），生产环境建议 `CONCURRENTLY`。
