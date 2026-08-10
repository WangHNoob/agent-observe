import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchExecution, fetchTrace, fetchTraces, type Span } from "../api/observe";
import { CopyId, Empty, ErrorBox, Spin, StatusBadge, fmtTime } from "../components/Atoms";
import { PageHeader } from "../components/Layout";
import { SpanInspector } from "../components/SpanInspector";
import { Waterfall } from "../components/Waterfall";

export function ExecutionDetail() {
  const { id = "" } = useParams();
  const [selected, setSelected] = useState<Span | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["execution", id],
    queryFn: () => fetchExecution(id),
  });

  const execTraces = useQuery({
    queryKey: ["execution-traces", id],
    queryFn: () => fetchTraces({ executionId: id, limit: 1 }),
  });
  const firstTraceId = execTraces.data?.items?.[0]?.id ?? null;
  const traceDetail = useQuery({
    queryKey: ["execution-trace-detail", firstTraceId],
    queryFn: () => fetchTrace(firstTraceId!),
    enabled: firstTraceId != null,
  });

  if (isLoading) return <Spin label="加载 Execution…" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty text="Execution 不存在" hint="可能已被清理，或 ID 不正确" />;

  const { execution, tasks } = data;

  return (
    <>
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

      <div className="card">
        <h2>Execution 元信息</h2>
        <dl className="kv">
          <dt>sessionId</dt>
          <dd>
            <Link to={`/traces?sessionId=${execution.sessionId}`}>{execution.sessionId}</Link>
          </dd>
          <dt>idempotencyKey</dt>
          <dd>{execution.idempotencyKey}</dd>
          <dt>userId</dt>
          <dd>{execution.userId}</dd>
          <dt>errorClass</dt>
          <dd>{execution.errorClass ?? "—"}</dd>
          <dt>errorMessage</dt>
          <dd>{execution.errorMessage ?? "—"}</dd>
          <dt>deadlineAt</dt>
          <dd>{execution.deadlineAt ?? "—"}</dd>
        </dl>
      </div>

      {execution.resultPayload?.output ? (
        <div className="card">
          <h2>Agent 输出（结果）</h2>
          <div className="output-box result">{String(execution.resultPayload.output)}</div>
        </div>
      ) : null}

      {traceDetail.data ? (
        <div className="card">
          <h2>
            关联 Trace（{traceDetail.data.spans.length} span）
            <span style={{ marginLeft: "auto", textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>
              <Link to={`/traces/${traceDetail.data.trace.id}`}>打开完整详情 →</Link>
            </span>
          </h2>
          <Waterfall
            spans={traceDetail.data.spans}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
          {!selected ? (
            <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
              点击 span 行查看详情
            </div>
          ) : null}
        </div>
      ) : null}
      {selected ? <SpanInspector span={selected} onClose={() => setSelected(null)} /> : null}

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
        <pre className="raw-json" style={{ maxHeight: 260, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-soft)" }}>
          {JSON.stringify(execution.requestPayload, null, 2)}
        </pre>
      </div>
    </>
  );
}
