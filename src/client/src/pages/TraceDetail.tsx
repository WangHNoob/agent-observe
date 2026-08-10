import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deleteTrace, fetchTrace, type Span } from "../api/observe";
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
import { SpanInspector } from "../components/SpanInspector";
import { Waterfall } from "../components/Waterfall";

export function TraceDetail() {
  const { id = "" } = useParams();
  const [selected, setSelected] = useState<Span | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["trace", id],
    queryFn: () => fetchTrace(id),
  });

  const delMutation = useMutation({
    mutationFn: () => deleteTrace(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["traces"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      navigate("/traces");
    },
  });

  const confirmDelete = async () => {
    if (!window.confirm(`删除 trace「${data?.trace.name ?? id}」(${id.slice(0, 12)}…)？\n将级联删除其 span / cost / audit，不可恢复。`)) {
      return;
    }
    await delMutation.mutateAsync();
  };

  if (isLoading) return <Spin label="加载 Trace 详情…" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty text="Trace 不存在" />;

  const { trace, spans, executionSummary, spansLite } = data;
  const tokens = data.costRows.reduce((a, c) => a + c.inputTokens + c.outputTokens, 0);
  const hasSummary =
    executionSummary &&
    (executionSummary.requirement != null || executionSummary.output != null);

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
          <span style={{ marginLeft: "auto" }}>
            <button className="icon-btn" title="删除此 trace" disabled={delMutation.isPending} onClick={confirmDelete}>
              <Trash2 size={14} />
              {delMutation.isPending ? "删除中…" : "删除"}
            </button>
          </span>
        </div>
      </div>

      {hasSummary ? (
        <div className="card">
          <h2>请求与 Agent 输出</h2>
          <dl className="kv">
            <dt>requirement</dt>
            <dd>
              <div className="output-box" style={{ maxHeight: 160 }}>
                {String(executionSummary.requirement ?? "—")}
              </div>
            </dd>
            <dt>agent 输出</dt>
            <dd>
              <div className="output-box result">
                {String(executionSummary.output ?? "（无输出）")}
              </div>
            </dd>
          </dl>
        </div>
      ) : null}

      <div className="card">
        <h2>Span 瀑布图（{spans.length} 个 span）</h2>
        <Waterfall spans={spans} selectedId={selected?.id ?? null} onSelect={setSelected} />
        {!selected && spans.length > 0 ? (
          <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
            点击任意 span 行按需加载入参 / 出参 / 思考过程
          </div>
        ) : null}
      </div>

      {selected ? (
        <SpanInspector span={selected} traceId={trace.id} spansLite={spansLite} />
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
                  <tr key={`${c.agentName}-${c.modelName}-${c.createdAt}-${i}`}>
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
                  <tr key={`${a.action}-${a.createdAt}-${i}`}>
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
