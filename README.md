# agent-observe — Agent 全链路观测台

独立于 design-agent 的只读观测工程：直连 design-agent 的共享 PostgreSQL，以**只读角色**可视化 agent 全链路（Trace/Span 瀑布图、执行状态机、Token 成本、审计事件），agent 端零改动。

```
┌──────────────┐   HTTP /api   ┌──────────────────┐  只读 SELECT   ┌───────────────────────┐
│  Vite React  │ ────────────▶ │  Fastify 5 后端  │ ─────────────▶ │  gdt-postgres:5433     │
│  (5180)      │  (dev 代理)   │  (4180)          │   obs_reader   │  game_designer 库      │
└──────────────┘               └──────────────────┘  角色          │  agent_trace_* 等 9 表 │
                                                                  └───────────────────────┘
```

- **隔离**：与 design-agent 完全解耦。查询路径只出不进（`obs_reader` + 连接串强制 `default_transaction_read_only=on` 双保险）；**管理路径**（删除/清理）走独立 `obs_manager` 角色，仅授权 SELECT/DELETE/INSERT 且仅用于 trace 数据治理，不配置 `OBS_MANAGER_DATABASE_URL` 则管理功能整体禁用。
- **数据范围**：`agent_trace_sessions` / `agent_traces` / `agent_spans`（链路）、`cost_usage`（Token/费用）、`audit_logs`（审计）、`sessions` / `executions` / `execution_tasks` / `execution_attempts`（执行纵深）。
- **数据保留**：trace 默认**永久保存**（无 TTL）；配置 `OBS_TRACE_RETENTION_DAYS`（默认 90，0=禁用）后，后台清理器按小时删除过期 trace（级联 span + 关联 cost/audit + 孤儿会话）。
- **权限**：单管理员密码登录（JWT 12h），面向本地/自部署，不做多用户体系。

## 快速开始

前置：design-agent 的 PostgreSQL 已在运行（`gdt-postgres`，端口 5433）。

```bash
# 1. 一次性：创建数据库角色（obs_reader 只读 + obs_manager 管理；幂等，可重复执行）
pnpm db:create-role
# 1b. 一次性：创建观测台自有指标 schema（obs_metrics.metric_hourly；幂等）
node scripts/create-metrics-schema.mjs
# 或手动：
#   PGPASSWORD=game_designer psql -h localhost -p 5433 -U game_designer -d game_designer \
#     -c "CREATE ROLE obs_reader LOGIN PASSWORD 'obs_reader_dev'; GRANT CONNECT ON DATABASE game_designer TO obs_reader; GRANT USAGE ON SCHEMA public TO obs_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO obs_reader; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO obs_reader;"

# 2. 配置
cp .env.example .env   # 修改 OBS_JWT_SECRET / OBS_ADMIN_PASSWORD

# 3. 安装与启动
pnpm install
pnpm dev               # 后端 http://localhost:4180
pnpm dev:web           # 前端 http://localhost:5180（/api 代理到 4180）

# 生产一体托管（后端同时服务构建好的前端）
pnpm build && pnpm start
```

## API

查询（只读，`obs_reader`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 管理员密码 → JWT |
| GET | `/api/auth/me` | 当前 JWT 身份 |
| GET | `/api/health` | 健康检查（无需鉴权） |
| GET | `/api/meta` | 轻量元信息：`retentionDays` / `pruneAvailable`（无 DB 聚合） |
| GET | `/api/overview` | 24h 总览：数量/错误率/时长分位/Token/趋势桶/最近错误/保留配置（服务端约 15s 短缓存） |
| GET | `/api/traces` | 列表（userId/sessionId/executionId/name/mode/status/from/to + 分页；先分页再聚合 cost） |
| GET | `/api/traces/:id` | 详情：trace + **lite spans**（默认仅保留 token 键）+ cost + audit + `executionSummary`；`?full=1` 返回完整 span attributes |
| GET | `/api/traces/:id/spans/:spanId` | 按需拉取单个 span 的完整 attributes（瀑布图点击后） |
| GET | `/api/executions/:id` | 执行详情：七态 execution + DAG tasks + attempts；`?include=primaryTrace` 一次附带主 Trace（lite spans） |
| GET | `/api/sessions/:id` | 会话详情：会话 + 其 traces + 其 executions |
| GET | `/api/metrics/trend?days=N` | 小时级指标趋势（1–90 天，数据源 obs_metrics.metric_hourly；未配置 manager 时 `metricsEnabled=false`） |

管理（`obs_manager`，未配置 `OBS_MANAGER_DATABASE_URL` 时返回 503）：

| 方法 | 路径 | 说明 |
|------|------|------|
| DELETE | `/api/traces/:id` | 删除单条 trace（级联 span + cost/audit + 孤儿会话） |
| POST | `/api/traces/prune` | 按筛选批量清理：`{ filters, dryRun }`；dryRun 只返回匹配数（删除用单次 CTE） |

保留（TTL）：`OBS_TRACE_RETENTION_DAYS`（默认 90，0=禁用）——清理器启动时跑一次，之后按 `OBS_RETENTION_SWEEP_INTERVAL_MS`（默认 1h）定期删除 `started_at` 早于保留期的 trace。

## 前端页面

深色仪器台主题（DM Sans + IBM Plex Mono）：统一空态 / 加载态 / 错误态，详情页可返回，Trace ID 可复制。

- `/` 总览：指标卡 + 24h 逐小时趋势条图 + 分模式统计 + 最近错误（约 30s 轮询，配合 overview 短缓存）
- `/traces` 列表：多条件筛选（Enter / 重置）+ 分页；保留策略走 `/api/meta`；**单条删除**与**批量清理面板**（预览匹配数 → 确认删除）
- `/traces/:id` 详情：**span 瀑布图**（九态 phase 着色，键盘可选中）→ 点击后再拉完整 attributes；内嵌 requirement / agent 输出摘要；cost / audit；删除入口
- `/executions/:id` 详情：一次请求含主 Trace 瀑布图 + 任务 DAG + attempts 重试链

## 性能要点

- Trace 列表：先 `LIMIT/OFFSET` 再 JOIN `cost_usage` 聚合，避免对全量匹配行 GROUP BY
- Trace / Execution 详情：默认 lite spans，大段 tool/LLM JSON 按需加载
- Overview：15s 进程内短缓存；`recentErrors` 限制在近 24h；mode 统计优先 JOIN `executions.mode`（trace 名解析仅作回退）
- 指标：小时级聚合写入独立 schema `obs_metrics`（`/api/metrics/trend` 跨天趋势），24h overview 趋势桶优先使用指标表、空表时回退实时聚合
- schema 契约：启动 + 每小时复检 `information_schema` 对比 `schema-contract.json`，漂移 fail-fast（`OBS_SCHEMA_STRICT=false` 降级告警）
- 前端：Waterfall `useMemo` + 行 memo；JSON 仅在展开时语法高亮；大结果表截断展示

## 测试

```bash
pnpm typecheck
pnpm test        # 真实 PostgreSQL + app.inject 路由测试
                 # 管理用例用 obs_manager 自建 fixture（插入后由被测删除逻辑清理），不触碰真实数据
pnpm build       # 前端 vite 构建
```

## 路线图（未实施）

- Redis 执行事件流回放（chunk 文本回放，依赖 design-agent Redis 留存）
- OTLP exporter 对接（Jaeger/Tempo，属 agent 端事项）
- 多用户 / 只读角色密码轮换
- 共享库建议索引落地：见 [docs/suggested-indexes.md](./docs/suggested-indexes.md)（在 design-agent 的 drizzle 迁移中执行）
- 告警引擎（错误率/token 风暴/HITL 挂起 → webhook）与观测信号回流知识库飞轮（flywheel-plans/03 后续 Phase）
