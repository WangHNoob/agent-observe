import { useQuery } from "@tanstack/react-query";
import { MousePointerClick } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchExecution, type Span } from "../api/observe";
import { CopyId, Empty, ErrorBox, Spin, StatusBadge, fmtTime } from "../components/Atoms";
import { PageHeader } from "../components/Layout";
import { SpanInspector } from "../components/SpanInspector";
import { Waterfall } from "../components/Waterfall";

export function ExecutionDetail() {
  const { id = "" } = useParams();
  const [selected, setSelected] = useState<Span | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["execution", id, "primaryTrace"],
    queryFn: () => fetchExecution(id, { includePrimaryTrace: true }),
  });

  if (isLoading) return <Spin label="加载 Execution…" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty text="Execution 不存在" hint="可能已被清理，或 ID 不正确" />;

  const { execution, tasks, primaryTrace } = data;

  return (
    <div className="detail-page">
      <PageHeader
        title={<CopyId value={execution.id} />}
        subtitle={
          <span className="mono" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <StatusBadge status={execution.status} />
            <span>创建 {fmtTime(execution.createdAt)}</span>
            {execution.completedAt ? <span>完成 {fmtTime(execution.completedAt)}</span> : null}
          </span>
        }
        backTo="/traces"
        backLabel="返回 Trace 列表"
      />

      <div className="meta-strip">
        <div className="meta-chip">
          <span className="meta-k">session</span>
          <Link className="meta-v mono" to={`/traces?sessionId=${execution.sessionId}`}>
            {execution.sessionId.slice(0, 14)}…
          </Link>
        </div>
        <div className="meta-chip">
          <span className="meta-k">user</span>
          <span className="meta-v mono" title={execution.userId}>
            {execution.userId.slice(0, 10)}…
          </span>
        </div>
        <div className="meta-chip">
          <span className="meta-k">idempotency</span>
          <span className="meta-v mono" title={execution.idempotencyKey}>
            {execution.idempotencyKey.slice(0, 16)}…
          </span>
        </div>
        {execution.errorClass ? (
          <div className="meta-chip warn">
            <span className="meta-k">error</span>
            <span className="meta-v mono">{execution.errorClass}</span>
          </div>
        ) : null}
        {execution.deadlineAt ? (
          <div className="meta-chip">
            <span className="meta-k">deadline</span>
            <span className="meta-v mono">{fmtTime(execution.deadlineAt)}</span>
          </div>
        ) : null}
      </div>

      {execution.resultPayload?.output || execution.errorMessage ? (
        <div className="io-strip">
          {execution.resultPayload?.output ? (
            <details className="io-panel">
              <summary>Agent 输出</summary>
              <div className="output-box result" style={{ maxHeight: 140, marginTop: 8 }}>
                {String(execution.resultPayload.output)}
              </div>
            </details>
          ) : null}
          {execution.errorMessage ? (
            <details className="io-panel" open>
              <summary>错误信息</summary>
              <div className="output-box" style={{ maxHeight: 140, marginTop: 8, borderLeftColor: "var(--error)" }}>
                {execution.errorMessage}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {primaryTrace ? (
        <div className="trace-workspace">
          <section className="trace-pane spans" aria-label="关联 Trace 瀑布图">
            <div className="pane-head">
              <h2>Trace · {primaryTrace.spans.length} span</h2>
              <Link to={`/traces/${primaryTrace.trace.id}`} className="pane-action">
                完整详情 →
              </Link>
            </div>
            <div className="pane-body">
              <Waterfall
                spans={primaryTrace.spans}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
              />
            </div>
          </section>
          <section className="trace-pane inspector" aria-label="Span 详情">
            <div className="pane-head">
              <h2>Inspector</h2>
            </div>
            <div className="pane-body">
              {selected ? (
                <SpanInspector
                  span={selected}
                  traceId={primaryTrace.trace.id}
                  spansLite={primaryTrace.spansLite}
                  onClose={() => setSelected(null)}
                  docked
                />
              ) : (
                <div className="inspector-empty">
                  <div className="empty-icon">
                    <MousePointerClick size={18} />
                  </div>
                  <div className="empty-title">选择左侧 span</div>
                  <div className="empty-hint">点击瀑布图中的任意一行查看详情</div>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <div className="detail-secondary">
        <div className="card">
          <h2>任务 DAG（{tasks.length}）</h2>
          {tasks.length === 0 ? (
            <Empty text="无任务记录" hint="可能尚未进入 DAG 阶段" />
          ) : (
            tasks.map((t) => (
              <div key={t.id} className="task-card">
                <div className="task-card-head">
                  <StatusBadge status={t.status} />
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {t.name}
                  </span>
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
                      <tr>
                        <th>attempt</th>
                        <th>状态</th>
                        <th>errorClass</th>
                        <th>errorCode</th>
                        <th>信息</th>
                        <th>时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.attempts.map((a) => (
                        <tr key={a.attemptNumber}>
                          <td className="num">#{a.attemptNumber}</td>
                          <td>
                            <StatusBadge status={a.status} />
                          </td>
                          <td className="mono">{a.errorClass ?? "—"}</td>
                          <td className="mono">{a.errorCode ?? "—"}</td>
                          <td style={{ color: a.errorMessage ? "var(--error)" : undefined }}>
                            {a.errorMessage ?? "—"}
                          </td>
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
          <pre
            className="raw-json"
            style={{ maxHeight: 260, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-soft)" }}
          >
            {JSON.stringify(execution.requestPayload, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
