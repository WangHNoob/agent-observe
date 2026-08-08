import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { fetchExecution } from "../api/observe";
import { Empty, ErrorBox, Spin, StatusBadge, fmtTime } from "../components/Atoms";
import { PageHeader } from "../components/Layout";

export function ExecutionDetail() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["execution", id],
    queryFn: () => fetchExecution(id),
  });

  if (isLoading) return <Spin />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty text="Execution 不存在" />;

  const { execution, tasks } = data;

  return (
    <>
      <PageHeader
        title={<span className="mono">{execution.id}</span>}
        subtitle={
          <span className="mono" style={{ fontSize: 12 }}>
            <StatusBadge status={execution.status} />
            {" · "}创建 {fmtTime(execution.createdAt)}
            {execution.completedAt ? ` · 完成 ${fmtTime(execution.completedAt)}` : ""}
          </span>
        }
      />

      <div className="card">
        <h2>Execution 元信息</h2>
        <dl className="kv">
          <dt>sessionId</dt>
          <dd><Link to={`/traces?sessionId=${execution.sessionId}`}>{execution.sessionId}</Link></dd>
          <dt>idempotencyKey</dt><dd>{execution.idempotencyKey}</dd>
          <dt>userId</dt><dd>{execution.userId}</dd>
          <dt>errorClass</dt><dd>{execution.errorClass ?? "—"}</dd>
          <dt>errorMessage</dt><dd>{execution.errorMessage ?? "—"}</dd>
          <dt>deadlineAt</dt><dd>{execution.deadlineAt ?? "—"}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>任务 DAG（{tasks.length} 个任务）</h2>
        {tasks.length === 0 ? (
          <Empty text="无任务记录（可能未进入 DAG 阶段）" />
        ) : (
          tasks.map((t) => (
            <div key={t.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <StatusBadge status={t.status} />
                <span className="mono" style={{ fontWeight: 600 }}>{t.name}</span>
                <span className="muted mono">{t.taskKey}</span>
                {t.agentName ? <span className="badge neutral">{t.agentName}</span> : null}
                <span className="muted mono" style={{ marginLeft: "auto" }}>
                  pos {t.position}
                  {Array.isArray(t.dependencies) && t.dependencies.length > 0
                    ? ` · deps [${(t.dependencies as string[]).join(", ")}]`
                    : ""}
                </span>
              </div>
              {t.errorMessage ? (
                <div style={{ color: "var(--error)", marginTop: 8, fontSize: 13 }}>
                  <span className="mono">{t.errorClass ?? "error"}</span>：{t.errorMessage}
                </div>
              ) : null}
              {t.attempts.length > 0 ? (
                <table className="data" style={{ marginTop: 10 }}>
                  <thead>
                    <tr><th>attempt</th><th>状态</th><th>errorClass</th><th>errorCode</th><th>信息</th><th>时间</th></tr>
                  </thead>
                  <tbody>
                    {t.attempts.map((a) => (
                      <tr key={a.attemptNumber}>
                        <td className="num">#{a.attemptNumber}</td>
                        <td><StatusBadge status={a.status} /></td>
                        <td className="mono">{a.errorClass ?? "—"}</td>
                        <td className="mono">{a.errorCode ?? "—"}</td>
                        <td style={{ color: a.errorMessage ? "var(--error)" : undefined }}>{a.errorMessage ?? "—"}</td>
                        <td className="mono">{fmtTime(a.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>请求负载（requirement）</h2>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12.5, maxHeight: 260, overflowY: "auto" }}>
          {JSON.stringify(execution.requestPayload, null, 2)}
        </pre>
      </div>
    </>
  );
}
