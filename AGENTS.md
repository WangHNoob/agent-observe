# Agent 开发规范（agent-observe）

> 独立观测工程。查询路径只读；管理路径（删除/清理）走独立 `obs_manager` 角色且仅限 trace 数据治理。

## 铁律

1. **查询只读**：连接串强制 `default_transaction_read_only=on`；查询 SQL 只允许 SELECT。新增数据源必须先走 obs_reader 验证。
2. **管理写路径有界**：写操作（删除 trace / 批量清理 / TTL 清理器）必须走 `obs_manager` 连接、仅限 `agent_trace_*`/`cost_usage`/`audit_logs` 的 trace 关联行，且必须经 `TraceService` 的管理方法（事务内）执行；禁止新增其他写能力。未配置 `OBS_MANAGER_DATABASE_URL` 时管理接口必须返回 503。
3. **不解耦倒挂**：本工程不依赖 design-agent 源码/构建产物，仅依赖其数据库 schema 约定；schema 变更时以 `drizzle/*.sql` 为准同步 SQL。
4. **分层**：`routes/`（参数校验 + 编排）→ `services/`（纯 SQL）→ `db.ts`（pg 门面）。禁止在 routes 内直接写 SQL。
5. **租户边界**：查询一律带 user_id 过滤条件（可选参数）；批量清理必须有显式筛选条件，禁止无条件全表删除。
6. **鉴权**：除 `/api/auth/login`、`/api/health` 外全部走 JWT preHandler；管理接口同权限，禁止匿名调用。

## 变更流程

1. 后端改动 → `pnpm typecheck` + `pnpm test`（真实 PG；管理用例 fixture 自建自删）
2. 前端改动 → `pnpm build`（vite 构建通过）
3. 提交前自查：管理 SQL 是否在事务内、是否有 dry-run 预览、无硬编码密钥（用 `.env.example` + `config.ts`）、README 同步
