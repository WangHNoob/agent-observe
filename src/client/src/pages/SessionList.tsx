import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { fetchSessions, type SessionFilters } from "../api/observe";
import { Empty, ErrorBox, Spin, StatusBadge, fmtMicrosCost, fmtTime, fmtTokens } from "../components/Atoms";
import { PageHeader } from "../components/Layout";
import { useListFilters } from "../hooks/useListFilters";

const PAGE_SIZE = 50;

export function SessionList() {
  const navigate = useNavigate();
  const { filters, draft, setDraft, page, setPage, apply, reset } = useListFilters([
    "mode",
    "status",
    "q",
  ]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sessions", filters, page],
    queryFn: () => fetchSessions({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE } as SessionFilters),
  });

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;

  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  return (
    <div className="list-page">
      <PageHeader title="会话" subtitle="设计会话列表（近 → 远），下钻查看执行与 Trace" />

      <div className="list-workspace">
        <aside className="filter-rail" onKeyDown={onFilterKey}>
          <div className="rail-section">
            <h2>筛选</h2>
            <label className="rail-field">
              <span>模式</span>
              <select value={draft.mode ?? ""} onChange={(e) => setDraft({ ...draft, mode: e.target.value || undefined })}>
                <option value="">全部</option>
                <option value="query">query</option>
                <option value="design">design</option>
                <option value="table">table</option>
              </select>
            </label>
            <label className="rail-field">
              <span>状态</span>
              <select value={draft.status ?? ""} onChange={(e) => setDraft({ ...draft, status: e.target.value || undefined })}>
                <option value="">全部</option>
                <option value="completed">completed</option>
                <option value="running">running</option>
                <option value="failed">failed</option>
                <option value="cancelled">cancelled</option>
              </select>
            </label>
            <label className="rail-field">
              <span>需求搜索</span>
              <input
                type="text"
                placeholder="包含…"
                value={draft.q ?? ""}
                onChange={(e) => setDraft({ ...draft, q: e.target.value || undefined })}
              />
            </label>
            <div className="rail-actions">
              <button className="btn" onClick={apply}>
                筛选
              </button>
              <button className="btn ghost" type="button" onClick={reset}>
                重置
              </button>
            </div>
          </div>
          <div className="rail-section">
            <h2>层级说明</h2>
            <p className="rail-hint">
              会话（session）→ 执行（execution）→ Trace → Span。
              Trace 与 Span 的检索在 <b>Trace 列表</b>，Span 细节在 Trace 详情的瀑布图。
            </p>
          </div>
        </aside>

        <div className="list-main">
          {isLoading ? (
            <Spin label="加载会话列表…" />
          ) : error ? (
            <ErrorBox error={error} />
          ) : !data || data.items.length === 0 ? (
            <div className="card" style={{ marginBottom: 0 }}>
              <Empty text="没有匹配的会话" hint="试试放宽筛选条件" />
            </div>
          ) : (
            <div className="table-wrap" style={{ marginBottom: 0 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>模式</th>
                    <th>状态</th>
                    <th>需求</th>
                    <th className="num">执行</th>
                    <th className="num">Trace</th>
                    <th className="num">Token</th>
                    <th className="num">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr
                      key={s.id}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => navigate(`/sessions/${s.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/sessions/${s.id}`);
                        }
                      }}
                      title="点击查看会话详情"
                    >
                      <td className="mono">{fmtTime(s.createdAt)}</td>
                      <td>{s.mode}</td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                      <td style={{ maxWidth: 360 }}>
                        <span className="mono" style={{ fontSize: 12 }} title={s.requirement}>
                          {s.requirement.length > 60 ? `${s.requirement.slice(0, 60)}…` : s.requirement}
                        </span>
                      </td>
                      <td className="num">{s.executionCount}</td>
                      <td className="num">{s.traceCount}</td>
                      <td className="num">{fmtTokens(s.inputTokens + s.outputTokens)}</td>
                      <td className="num">{fmtMicrosCost(s.costMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pager">
                <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  上一页
                </button>
                <span className="mono">
                  {page + 1} / {totalPages} · 共 {data.total} 条
                </span>
                <button className="btn ghost" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>
                  下一页
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
