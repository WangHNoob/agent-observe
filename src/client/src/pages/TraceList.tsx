import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchTraces, type TraceFilters } from "../api/observe";
import { Empty, ErrorBox, Spin, StatusBadge, fmtMs, fmtTime, fmtTokens } from "../components/Atoms";
import { PageHeader } from "../components/Layout";

const PAGE_SIZE = 50;

export function TraceList() {
  const [search, setSearch] = useSearchParams();
  const [filters, setFilters] = useState<TraceFilters>(() => ({
    mode: search.get("mode") ?? undefined,
    status: search.get("status") ?? undefined,
    name: search.get("name") ?? undefined,
    sessionId: search.get("sessionId") ?? undefined,
    executionId: search.get("executionId") ?? undefined,
    userId: search.get("userId") ?? undefined,
  }));
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState(filters);

  useEffect(() => {
    setFilters({
      mode: search.get("mode") ?? undefined,
      status: search.get("status") ?? undefined,
      name: search.get("name") ?? undefined,
      sessionId: search.get("sessionId") ?? undefined,
      executionId: search.get("executionId") ?? undefined,
      userId: search.get("userId") ?? undefined,
    });
  }, [search]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["traces", filters, page],
    queryFn: () => fetchTraces({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const apply = () => {
    setPage(0);
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) {
      if (v) next.set(k, v);
    }
    setSearch(next);
  };

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;

  return (
    <>
      <PageHeader title="Trace 列表" subtitle="浏览 agent 全链路记录（近 → 远）" />

      <div className="filter-bar">
        <label>模式
          <select value={draft.mode ?? ""} onChange={(e) => setDraft({ ...draft, mode: e.target.value || undefined })}>
            <option value="">全部</option>
            <option value="query">query</option>
            <option value="design">design</option>
            <option value="table">table</option>
          </select>
        </label>
        <label>状态
          <select value={draft.status ?? ""} onChange={(e) => setDraft({ ...draft, status: e.target.value || undefined })}>
            <option value="">全部</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="unset">unset</option>
          </select>
        </label>
        <input type="text" placeholder="名称包含（如 director.query）" value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value || undefined })} />
        <input type="text" placeholder="sessionId" value={draft.sessionId ?? ""} onChange={(e) => setDraft({ ...draft, sessionId: e.target.value || undefined })} />
        <input type="text" placeholder="executionId" value={draft.executionId ?? ""} onChange={(e) => setDraft({ ...draft, executionId: e.target.value || undefined })} />
        <input type="text" placeholder="userId" value={draft.userId ?? ""} onChange={(e) => setDraft({ ...draft, userId: e.target.value || undefined })} />
        <button className="btn" onClick={apply}>筛选</button>
      </div>

      {isLoading ? <Spin /> : error ? <ErrorBox error={error} /> : !data || data.items.length === 0 ? (
        <Empty text="没有匹配的 trace" />
      ) : (
        <div className="card" style={{ padding: "8px 6px" }}>
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>模式</th>
                <th>状态</th>
                <th className="num">时长</th>
                <th className="num">Token</th>
                <th>executionId</th>
                <th>sessionId</th>
                <th>userId</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{fmtTime(t.startedAt)}</td>
                  <td><Link to={`/traces/${t.id}`}>{t.mode ?? t.name}</Link></td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="num">{fmtMs(t.durationMs)}</td>
                  <td className="num">{fmtTokens(t.inputTokens + t.outputTokens)}</td>
                  <td className="mono">{t.executionId ? <Link to={`/executions/${t.executionId}`}>{t.executionId.slice(0, 12)}…</Link> : "—"}</td>
                  <td className="mono">{t.sessionId.slice(0, 12)}…</td>
                  <td className="mono">{t.userId.slice(0, 8)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
            <span>
              {page + 1} / {totalPages} · 共 {data.total} 条
            </span>
            <button className="btn ghost" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </div>
      )}
    </>
  );
}
