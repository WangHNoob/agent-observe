# agent-observe — Agent 全链路观测台

独立于 design-agent 的只读观测工程：直连 design-agent 的共享 PostgreSQL，以**只读角色**可视化 agent 全链路（Trace/Span 瀑布图、执行状态机、Token 成本、审计事件），agent 端零改动。

```
┌──────────────┐   HTTP /api   ┌──────────────────┐  只读 SELECT   ┌───────────────────────┐
│  Vite React  │ ────────────▶ │  Fastify 5 后端  │ ─────────────▶ │  gdt-postgres:5433     │
│  (5180)      │  (dev 代理)   │  (4180)          │   obs_reader   │  game_designer 库      │
└──────────────┘               └──────────────────┘  角色          │  agent_trace_* 等 9 表 │
                                                                  └───────────────────────┘
```

- **隔离**：与 design-agent 完全解耦。数据只出不进（连接串强制 `default_transaction_read_only=on` 双保险），不注册任何写路径。
- **数据范围**：`agent_trace_sessions` / `agent_traces` / `agent_spans`（链路）、`cost_usage`（Token/费用）、`audit_logs`（审计）、`sessions` / `executions` / `execution_tasks` / `execution_attempts`（执行纵深）。
- **权限**：单管理员密码登录（JWT 12h），面向本地/自部署，不做多用户体系。

## 快速开始

前置：design-agent 的 PostgreSQL 已在运行（`gdt-postgres`，端口 5433）。

```bash
# 1. 一次性：创建只读角色（幂等，可重复执行）
pnpm db:create-role
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

## API（全部只读，JWT 保护）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 管理员密码 → JWT |
| GET | `/api/overview` | 24h 总览：数量/错误率/时长分位/Token/趋势桶/最近错误 |
| GET | `/api/traces` | 列表（userId/sessionId/executionId/name/mode/status/from/to + 分页） |
| GET | `/api/traces/:id` | 详情：trace + spans（瀑布图数据）+ cost + audit |
| GET | `/api/executions/:id` | 执行详情：七态 execution + DAG tasks + attempts 重试链 |
| GET | `/api/sessions/:id` | 会话详情：会话 + 其 traces + 其 executions |

## 前端页面

- `/` 总览：指标卡 + 24h 逐小时趋势条图 + 分模式统计 + 最近错误
- `/traces` 列表：多条件筛选 + 分页
- `/traces/:id` 详情：**span 瀑布图**（纯 CSS 按时长比例绘制，九态 phase 着色，error 红标）+ span 属性面板 + cost/audit 关联
- `/executions/:id` 详情：任务 DAG 序列 + 每次重试 attempt 的错误链

## 测试

```bash
pnpm test        # 真实只读 PostgreSQL + app.inject 路由测试（不做任何写入）
```

## 路线图（未实施）

- Redis 执行事件流回放（chunk 文本回放，依赖 design-agent Redis 留存）
- OTLP exporter 对接（Jaeger/Tempo，属 agent 端事项）
- 多用户 / 只读角色密码轮换
