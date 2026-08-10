import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  deleteTrace,
  fetchMeta,
  fetchTraces,
  pruneTraces,
  type TraceFilters,
} from "../api/observe";
import { Empty, ErrorBox, Spin, StatusBadge, fmtMs, fmtTime, fmtTokens } from "../components/Atoms";
import { PageHeader } from "../components/Layout";

const PAGE_SIZE = 50;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function TraceList() {
  const navigate = useNavigate();
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

  const meta = useQuery({ queryKey: ["meta"], queryFn: fetchMeta, staleTime: 60_000 });
  const pruneAvailable = meta.data?.pruneAvailable ?? false;
  const retentionDays = meta.data?.retentionDays ?? 0;

  const apply = () => {
    setPage(0);
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) {
      if (v) next.set(k, v);
    }
    setSearch(next);
  };

  const resetFilters = () => {
    setDraft({});
    setPage(0);
    setSearch(new URLSearchParams());
  };

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;

  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["traces"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    void queryClient.invalidateQueries({ queryKey: ["meta"] });
  };

  const delMutation = useMutation({
    mutationFn: (id: string) => deleteTrace(id),
    onSuccess: refresh,
  });

  const [pruneStatus, setPruneStatus] = useState<string>("unset");
  const [pruneDays, setPruneDays] = useState<number | "">("");
  const [preview, setPreview] = useState<number | null>(null);
  const [previewMsg, setPreviewMsg] = useState<string | null>(null);
  const pruneMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      pruneTraces(
        {
          status: pruneStatus || undefined,
          to: pruneDays === "" ? undefined : daysAgoIso(pruneDays),
        },
        dryRun,
      ),
    onSuccess: (res) => {
      if (res.dryRun) {
        setPreview(res.matched);
        setPreviewMsg(null);
      } else {
        setPreview(null);
        setPreviewMsg(`已删除 ${res.matched} 条 trace`);
        refresh();
      }
    },
  });

  const deleteOne = async (id: string, name: string) => {
    if (!window.confirm(`删除 trace「${name}」(${id.slice(0, 12)}…)？\n将级联删除其 span / cost / audit，不可恢复。`)) {
      return;
    }
    await delMutation.mutateAsync(id);
  };

  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  return (
    <>
      <PageHeader title="Trace 列表" subtitle="浏览 agent 全链路记录（近 → 远）" />

      {pruneAvailable ? (
        <div className="card">
          <h2>数据保留与清理（TTL {retentionDays > 0 ? `${retentionDays} 天` : "已禁用"}）</h2>
          <div className="filter-bar" style={{ marginBottom: 0, boxShadow: "none", padding: 0, border: "none", background: "transparent" }}>
            <label>
              状态
              <select value={pruneStatus} onChange={(e) => setPruneStatus(e.target.value)}>
                <option value="unset">unset（未完成/异常）</option>
                <option value="ok">ok</option>
                <option value="error">error</option>
                <option value="">全部</option>
              </select>
            </label>
            <label>
              早于
              <input
                type="number"
                min={1}
                max={3650}
                placeholder="不限"
                value={pruneDays}
                onChange={(e) => setPruneDays(e.target.value === "" ? "" : Number(e.target.value))}
                style={{ width: 90 }}
              />
              天（留空 = 不限）
            </label>
            <button className="btn ghost" disabled={pruneMutation.isPending} onClick={() => pruneMutation.mutate(true)}>
              预览匹配数
            </button>
            {preview != null ? (
              <>
                <span className="mono">匹配 {preview} 条</span>
                <button
                  className="btn danger"
                  disabled={pruneMutation.isPending || preview === 0}
                  onClick={() => pruneMutation.mutate(false)}
                >
                  {pruneMutation.isPending ? "处理中…" : `确认删除 ${preview} 条`}
                </button>
              </>
            ) : null}
            {previewMsg ? <span className="toast-ok">{previewMsg}</span> : null}
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>数据保留</h2>
          <span className="muted">
            管理功能未启用：后端未配置 <code>OBS_MANAGER_DATABASE_URL</code>（删除/清理与 TTL 清理器不可用）
          </span>
        </div>
      )}

      <div className="filter-bar" onKeyDown={onFilterKey}>
        <label>
          模式
          <select value={draft.mode ?? ""} onChange={(e) => setDraft({ ...draft, mode: e.target.value || undefined })}>
            <option value="">全部</option>
            <option value="query">query</option>
            <option value="design">design</option>
            <option value="table">table</option>
          </select>
        </label>
        <label>
          状态
          <select value={draft.status ?? ""} onChange={(e) => setDraft({ ...draft, status: e.target.value || undefined })}>
            <option value="">全部</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="unset">unset</option>
          </select>
        </label>
        <input
          type="text"
          placeholder="名称包含…"
          value={draft.name ?? ""}
          onChange={(e) => setDraft({ ...draft, name: e.target.value || undefined })}
        />
        <input
          type="text"
          placeholder="sessionId"
          value={draft.sessionId ?? ""}
          onChange={(e) => setDraft({ ...draft, sessionId: e.target.value || undefined })}
        />
        <input
          type="text"
          placeholder="executionId"
          value={draft.executionId ?? ""}
          onChange={(e) => setDraft({ ...draft, executionId: e.target.value || undefined })}
        />
        <input
          type="text"
          placeholder="userId"
          value={draft.userId ?? ""}
          onChange={(e) => setDraft({ ...draft, userId: e.target.value || undefined })}
        />
        <button className="btn" onClick={apply}>
          筛选
        </button>
        <button className="btn ghost" type="button" onClick={resetFilters}>
          重置
        </button>
      </div>

      {isLoading ? (
        <Spin label="加载 Trace 列表…" />
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <Empty text="没有匹配的 trace" hint="试试放宽筛选条件，或换个时间窗口" />
        </div>
      ) : (
        <div className="table-wrap">
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr
                  key={t.id}
                  className="clickable"
                  tabIndex={0}
                  onClick={() => navigate(`/traces/${t.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/traces/${t.id}`);
                    }
                  }}
                  title="点击查看详情"
                >
                  <td className="mono">{fmtTime(t.startedAt)}</td>
                  <td>{t.mode ?? t.name}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="num">{fmtMs(t.durationMs)}</td>
                  <td className="num">{fmtTokens(t.inputTokens + t.outputTokens)}</td>
                  <td className="mono" onClick={(e) => e.stopPropagation()}>
                    {t.executionId ? (
                      <Link to={`/executions/${t.executionId}`}>{t.executionId.slice(0, 12)}…</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="mono" onClick={(e) => e.stopPropagation()} title={t.sessionId}>
                    {t.sessionId.slice(0, 12)}…
                  </td>
                  <td className="mono" title={t.userId}>
                    {t.userId.slice(0, 8)}…
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Link className="btn ghost" to={`/traces/${t.id}`} style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }}>
                      查看
                    </Link>
                    {pruneAvailable ? (
                      <button
                        className="icon-btn"
                        title="删除此 trace"
                        disabled={delMutation.isPending}
                        onClick={() => deleteOne(t.id, t.name)}
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </td>
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
    </>
  );
}
