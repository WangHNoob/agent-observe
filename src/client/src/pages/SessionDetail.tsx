import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { deleteTrace, fetchSession, type SessionDetail as SessionDetailData } from "../api/observe";
import {
  CopyId,
  Empty,
  ErrorBox,
  Spin,
  StatusBadge,
  fmtMicrosCost,
  fmtMs,
  fmtTime,
  fmtTokens,
} from "../components/Atoms";
import { PageHeader } from "../components/Layout";
import { useRole } from "../hooks/useRole";

/** 执行卡片内的 Trace 行表（session → execution → trace 层级展示） */
function TraceRows({
  traces,
  sessionId,
  isAdmin,
  deleting,
  onDelete,
}: {
  traces: SessionDetailData["traces"];
  sessionId: string;
  isAdmin: boolean;
  deleting: boolean;
  onDelete: (t: SessionDetailData["traces"][number]) => void;
}) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>名称</th>
          <th>模式</th>
          <th>状态</th>
          <th className="num">时长</th>
          <th className="num">Token</th>
          <th className="num">成本</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => (
          <tr key={t.id}>
            <td>
              <Link to={`/traces/${t.id}`} state={{ from: `/sessions/${sessionId}` }} title={t.name}>
                {t.name}
              </Link>
            </td>
            <td>{t.mode}</td>
            <td>
              <StatusBadge status={t.status} />
            </td>
            <td className="num">{fmtMs(t.durationMs)}</td>
            <td className="num">{fmtTokens(t.inputTokens + t.outputTokens)}</td>
            <td className="num">{fmtMicrosCost(t.costMicros)}</td>
            <td style={{ whiteSpace: "nowrap" }}>
              <Link className="btn ghost" to={`/traces/${t.id}`} state={{ from: `/sessions/${sessionId}` }} style={{ padding: "3px 10px", fontSize: 12, marginRight: 6 }}>
                查看
              </Link>
              {isAdmin ? (
                <button
                  className="icon-btn"
                  title="删除此 trace"
                  disabled={deleting}
                  onClick={() => onDelete(t)}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SessionDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const isAdmin = useRole() === "admin";

  const { data, isLoading, error } = useQuery({
    queryKey: ["session", id],
    queryFn: () => fetchSession(id),
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const delMutation = useMutation({
    mutationFn: (traceId: string) => deleteTrace(traceId),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["session", id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["traces"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });

  if (isLoading) return <Spin label="加载会话详情…" />;
  if (error) {
    // legacy 会话：54 条旧 trace 的 session_id 不在 sessions 表 → 引导去 Trace 列表
    if (error instanceof Error && error.message.includes("Session not found")) {
      return (
        <div className="detail-page">
          <PageHeader title="会话不存在" backTo="/sessions" backLabel="返回会话列表" />
          <div className="card" style={{ marginBottom: 0 }}>
            <Empty text="会话不存在" hint="可能是旧数据：该 session_id 不在 sessions 表中" />
            <p style={{ textAlign: "center" }}>
              <Link className="btn" to={`/traces?sessionId=${encodeURIComponent(id)}`}>
                按 sessionId 查 Trace
              </Link>
            </p>
          </div>
        </div>
      );
    }
    return <ErrorBox error={error} />;
  }
  if (!data) return <Empty text="会话不存在" />;

  const { session, traces, executions, totals } = data;
  const execIds = new Set(executions.map((e) => e.id));
  const unlinked = traces.filter((t) => !t.executionId || !execIds.has(t.executionId));

  const confirmDelete = (t: SessionDetailData["traces"][number]) => {
    if (!window.confirm(`删除 trace「${t.name}」(${t.id.slice(0, 12)}…)？\n将级联删除其 span / cost / audit，不可恢复。`)) {
      return;
    }
    delMutation.mutate(t.id);
  };

  return (
    <div className="detail-page">
      <PageHeader
        title={
          <span title={session.requirement}>
            {session.requirement.length > 48 ? `${session.requirement.slice(0, 48)}…` : session.requirement}
          </span>
        }
        subtitle={
          <span className="mono" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <CopyId value={session.id} />
            <StatusBadge status={session.status} />
            <span>{session.mode}</span>
            <span>{fmtTokens(totals.inputTokens + totals.outputTokens)} tok</span>
            <span>{fmtMicrosCost(totals.costMicros)}</span>
          </span>
        }
        backTo="/sessions"
        backLabel="返回会话列表"
      />

      {actionError ? (
        <div style={{ marginBottom: 12 }}>
          <span className="toast-err">{actionError}</span>
        </div>
      ) : null}

      <div className="meta-strip">
        <div className="meta-chip">
          <span className="meta-k">created</span>
          <span className="meta-v mono">{fmtTime(session.createdAt)}</span>
        </div>
        <div className="meta-chip">
          <span className="meta-k">updated</span>
          <span className="meta-v mono">{fmtTime(session.updatedAt)}</span>
        </div>
        <div className="meta-chip">
          <span className="meta-k">role</span>
          <span className="meta-v mono">{session.role}</span>
        </div>
        <div className="meta-chip">
          <span className="meta-k">user</span>
          <span className="meta-v mono" title={session.userId}>
            {session.userId.slice(0, 10)}…
          </span>
        </div>
      </div>

      <div className="io-strip">
        <details className="io-panel">
          <summary>需求 requirement</summary>
          <div className="output-box" style={{ maxHeight: 160, marginTop: 8 }}>
            {session.requirement}
          </div>
        </details>
        <details className="io-panel">
          <summary>Agent 输出</summary>
          <div className="output-box result" style={{ maxHeight: 160, marginTop: 8 }}>
            {session.output ?? "（无输出）"}
          </div>
        </details>
        {session.error ? (
          <details className="io-panel">
            <summary style={{ color: "var(--error)" }}>错误</summary>
            <div className="output-box" style={{ maxHeight: 160, marginTop: 8, color: "var(--error)" }}>
              {session.error}
            </div>
          </details>
        ) : null}
      </div>

      {executions.length > 0 ? (
        <div className="detail-secondary">
          <h2 style={{ marginBottom: 12 }}>执行（{executions.length}）</h2>
          {executions.map((e) => {
            const execTraces = traces.filter((t) => t.executionId === e.id);
            return (
              <div className="task-card" key={e.id} style={{ marginBottom: 12 }}>
                <div className="task-card-head" style={{ flexWrap: "wrap", gap: 8 }}>
                  <CopyId value={e.id} label="execution" />
                  <StatusBadge status={e.status} />
                  {e.mode ? <span className="badge neutral mono">{e.mode}</span> : null}
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {fmtTime(e.createdAt)}
                    {e.completedAt ? ` → ${fmtTime(e.completedAt)}` : ""}
                  </span>
                  <Link className="btn ghost" to={`/executions/${e.id}`} state={{ from: `/sessions/${id}` }} style={{ padding: "3px 10px", fontSize: 12 }}>
                    执行详情
                  </Link>
                </div>
                {execTraces.length > 0 ? (
                  <TraceRows traces={execTraces} sessionId={id} isAdmin={isAdmin} deleting={delMutation.isPending} onDelete={confirmDelete} />
                ) : (
                  <p className="rail-hint" style={{ margin: "8px 0 0" }}>该执行无关联 Trace</p>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {unlinked.length > 0 ? (
        <div className="detail-secondary">
          <h2 style={{ marginBottom: 12 }}>
            {executions.length > 0 ? `未关联执行的 Trace（${unlinked.length}）` : `Trace（${unlinked.length}）`}
          </h2>
          <div className="card" style={{ marginBottom: 0 }}>
            <TraceRows traces={unlinked} sessionId={id} isAdmin={isAdmin} deleting={delMutation.isPending} onDelete={confirmDelete} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
