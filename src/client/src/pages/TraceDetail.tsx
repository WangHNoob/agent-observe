import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MousePointerClick, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deleteTrace, fetchTrace, type Span } from "../api/observe";
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
  if (!data) return <Empty text="Trace 不存在" hint="可能已被清理，或 ID 不正确" />;

  const { trace, spans, executionSummary, spansLite } = data;
  const tokens = data.costRows.reduce((a, c) => a + c.inputTokens + c.outputTokens, 0);
  const hasSummary =
    executionSummary &&
    (executionSummary.requirement != null || executionSummary.output != null);

  return (
    <div className="detail-page">
      <PageHeader
        title={<span className="mono">{trace.name}</span>}
        subtitle={
          <span className="mono" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <CopyId value={trace.id} />
            <StatusBadge status={trace.status} />
            <span>{fmtMs(trace.durationMs)}</span>
            <span>{fmtTokens(tokens)} tok</span>
          </span>
        }
        backTo="/traces"
        backLabel="返回 Trace 列表"
        actions={
          <button className="icon-btn" title="删除此 trace" disabled={delMutation.isPending} onClick={confirmDelete}>
            <Trash2 size={14} />
            {delMutation.isPending ? "删除中…" : "删除"}
          </button>
        }
      />

      <div className="meta-strip">
        <div className="meta-chip">
          <span className="meta-k">started</span>
          <span className="meta-v mono">{fmtTime(trace.startedAt)}</span>
        </div>
        <div className="meta-chip">
          <span className="meta-k">ended</span>
          <span className="meta-v mono">{trace.endedAt ? fmtTime(trace.endedAt) : "—"}</span>
        </div>
        <div className="meta-chip">
          <span className="meta-k">session</span>
          <Link className="meta-v mono" to={`/traces?sessionId=${trace.sessionId}`}>
            {trace.sessionId.slice(0, 14)}…
          </Link>
        </div>
        <div className="meta-chip">
          <span className="meta-k">execution</span>
          {trace.executionId ? (
            <Link className="meta-v mono" to={`/executions/${trace.executionId}`}>
              {trace.executionId.slice(0, 14)}…
            </Link>
          ) : (
            <span className="meta-v mono">—</span>
          )}
        </div>
        <div className="meta-chip">
          <span className="meta-k">user</span>
          <span className="meta-v mono" title={trace.userId}>
            {trace.userId.slice(0, 10)}…
          </span>
        </div>
        {Object.keys(trace.attributes).length > 0 ? (
          <details className="meta-attrs">
            <summary>attributes</summary>
            <pre className="raw-json">{JSON.stringify(trace.attributes, null, 2)}</pre>
          </details>
        ) : null}
      </div>

      {hasSummary ? (
        <div className="io-strip">
          <details className="io-panel">
            <summary>请求 requirement</summary>
            <div className="output-box" style={{ maxHeight: 140, marginTop: 8 }}>
              {String(executionSummary.requirement ?? "—")}
            </div>
          </details>
          <details className="io-panel">
            <summary>Agent 输出</summary>
            <div className="output-box result" style={{ maxHeight: 140, marginTop: 8 }}>
              {String(executionSummary.output ?? "（无输出）")}
            </div>
          </details>
        </div>
      ) : null}

      <div className="trace-workspace">
        <section className="trace-pane spans" aria-label="Span 瀑布图">
          <div className="pane-head">
            <h2>Spans · {spans.length}</h2>
          </div>
          <div className="pane-body">
            <Waterfall spans={spans} selectedId={selected?.id ?? null} onSelect={setSelected} />
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
                traceId={trace.id}
                spansLite={spansLite}
                onClose={() => setSelected(null)}
                docked
              />
            ) : (
              <div className="inspector-empty">
                <div className="empty-icon">
                  <MousePointerClick size={18} />
                </div>
                <div className="empty-title">选择左侧 span</div>
                <div className="empty-hint">点击瀑布图中的任意一行，在此查看入参、出参与思考过程</div>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="detail-secondary two-col">
        <div className="card" style={{ marginBottom: 0 }}>
          <h2>Cost 明细（{data.costRows.length}）</h2>
          {data.costRows.length === 0 ? (
            <Empty text="无 cost 记录" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>agent</th>
                  <th>model</th>
                  <th className="num">in</th>
                  <th className="num">out</th>
                  <th className="num">cost</th>
                </tr>
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

        <div className="card" style={{ marginBottom: 0 }}>
          <h2>审计事件（{data.auditRows.length}）</h2>
          {data.auditRows.length === 0 ? (
            <Empty text="无审计记录" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>action</th>
                  <th>outcome</th>
                  <th>resource</th>
                </tr>
              </thead>
              <tbody>
                {data.auditRows.map((a, i) => (
                  <tr key={`${a.action}-${a.createdAt}-${i}`}>
                    <td className="mono">{fmtTime(a.createdAt)}</td>
                    <td className="mono">{a.action}</td>
                    <td>
                      <StatusBadge
                        status={a.outcome === "success" ? "ok" : a.outcome === "denied" ? "error" : "unset"}
                      />
                    </td>
                    <td className="mono">
                      {a.resourceType ?? "—"}
                      {a.resourceId ? `:${a.resourceId.slice(0, 14)}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
