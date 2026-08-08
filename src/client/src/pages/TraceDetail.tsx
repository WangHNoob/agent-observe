import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTrace, type Span } from "../api/observe";
import {
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
import { Waterfall } from "../components/Waterfall";

export function TraceDetail() {
  const { id = "" } = useParams();
  const [selected, setSelected] = useState<Span | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["trace", id],
    queryFn: () => fetchTrace(id),
  });

  if (isLoading) return <Spin />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty text="Trace 不存在" />;

  const { trace, spans } = data;
  const tokens = data.costRows.reduce((a, c) => a + c.inputTokens + c.outputTokens, 0);

  return (
    <>
      <PageHeader
        title={<span className="mono">{trace.name}</span>}
        subtitle={(
          <span className="mono" style={{ fontSize: 12 }}>
            {trace.id} · <StatusBadge status={trace.status} /> · {fmtMs(trace.durationMs)}
          </span>
        )}
      />

      <div className="card">
        <h2>Trace 元信息</h2>
        <dl className="kv">
          <dt>startedAt</dt><dd>{trace.startedAt}</dd>
          <dt>endedAt</dt><dd>{trace.endedAt ?? "—"}</dd>
          <dt>attributes</dt><dd>{JSON.stringify(trace.attributes)}</dd>
          <dt>token（cost 汇总）</dt><dd>{fmtTokens(tokens)}</dd>
        </dl>
        <div className="detail-ids">
          <span><b>sessionId</b> <Link to={`/traces?sessionId=${trace.sessionId}`}>{trace.sessionId}</Link></span>
          <span><b>executionId</b> {trace.executionId ? <Link to={`/executions/${trace.executionId}`}>{trace.executionId}</Link> : "—"}</span>
          <span><b>userId</b> {trace.userId}</span>
          <span><b>traceSessionId</b> {trace.traceSessionId}</span>
        </div>
      </div>

      <div className="card">
        <h2>Span 瀑布图（{spans.length} 个 span）</h2>
        <Waterfall spans={spans} selectedId={selected?.id ?? null} onSelect={setSelected} />
      </div>

      {selected ? (
        <div className="card">
          <h2>Span 详情 · {selected.name}</h2>
          <dl className="kv">
            <dt>id</dt><dd>{selected.id}</dd>
            <dt>parentSpanId</dt><dd>{selected.parentSpanId ?? "—"}</dd>
            <dt>phase</dt><dd>{selected.phase ?? "—"}</dd>
            <dt>kind</dt><dd>{selected.kind}</dd>
            <dt>status</dt><dd><StatusBadge status={selected.status} /></dd>
            <dt>duration</dt><dd>{fmtMs(selected.durationMs)}</dd>
            <dt>startedAt</dt><dd>{selected.startedAt}</dd>
            <dt>attributes</dt>
            <dd>
              {Object.keys(selected.attributes).length === 0 ? (
                <span className="muted">（空）</span>
              ) : (
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>
                  {JSON.stringify(selected.attributes, null, 2)}
                </pre>
              )}
            </dd>
          </dl>
        </div>
      ) : null}

      <div className="two-col">
        <div className="card">
          <h2>Cost 明细（{data.costRows.length} 行）</h2>
          {data.costRows.length === 0 ? (
            <Empty text="无 cost 记录" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>agent</th><th>model</th><th className="num">in</th><th className="num">out</th><th className="num">cost</th></tr>
              </thead>
              <tbody>
                {data.costRows.map((c, i) => (
                  <tr key={i}>
                    <td>{c.agentName ?? "—"}</td>
                    <td className="mono">{c.modelName ?? "—"}</td>
                    <td className="num">{fmtTokens(c.inputTokens)}</td>
                    <td className="num">{fmtTokens(c.outputTokens)}</td>
                    <td className="num">{fmtMicrosCost(c.estimatedCostMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>审计事件（{data.auditRows.length} 条）</h2>
          {data.auditRows.length === 0 ? (
            <Empty text="无审计记录" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>时间</th><th>action</th><th>outcome</th><th>resource</th></tr>
              </thead>
              <tbody>
                {data.auditRows.map((a, i) => (
                  <tr key={i}>
                    <td className="mono">{fmtTime(a.createdAt)}</td>
                    <td className="mono">{a.action}</td>
                    <td><StatusBadge status={a.outcome === "success" ? "ok" : a.outcome === "denied" ? "error" : "unset"} /></td>
                    <td className="mono">{a.resourceType ?? "—"}{a.resourceId ? `:${a.resourceId.slice(0, 14)}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
