# Agent 开发规范（agent-observe）

> 独立只读观测工程。数据只出不进：任何代码不得写 design-agent 的共享库。

## 铁律

1. **只读**：连接串强制 `default_transaction_read_only=on`；SQL 只允许 SELECT（含只读聚合/窗口函数）。新增数据源必须先走只读角色验证。
2. **不解耦倒挂**：本工程不依赖 design-agent 源码/构建产物，仅依赖其数据库 schema 约定；schema 变更时以 `drizzle/*.sql` 为准同步 SQL。
3. **分层**：`routes/`（参数校验 + 编排）→ `services/`（纯 SQL）→ `db.ts`（pg 门面）。禁止在 routes 内直接写 SQL。
4. **租户边界**：查询一律带 user_id 过滤条件（可选参数），不得提供跨租户导出。
5. **鉴权**：除 `/api/auth/login`、`/api/health` 外全部走 JWT preHandler；禁止新增匿名数据接口。

## 变更流程

1. 后端改动 → `pnpm typecheck` + `pnpm test`（真实只读 PG）
2. 前端改动 → `pnpm build`（vite 构建通过）
3. 提交前自查：无写 SQL、无硬编码密钥（用 `.env.example` + `config.ts`）、README 同步
