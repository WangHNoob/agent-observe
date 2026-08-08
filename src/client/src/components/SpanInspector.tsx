import type { Span } from "../api/observe";
import { StatusBadge, fmtMs } from "./Atoms";

/** span 属性面板（瀑布图点击后展示），trace 详情与执行详情共用。 */
export function SpanInspector({ span }: { span: Span }) {
  return (
    <div className="card">
      <h2>Span 详情 · {span.name}</h2>
      <dl className="kv">
        <dt>id</dt><dd>{span.id}</dd>
        <dt>parentSpanId</dt><dd>{span.parentSpanId ?? "—"}</dd>
        <dt>phase</dt><dd>{span.phase ?? "—"}</dd>
        <dt>kind</dt><dd>{span.kind}</dd>
        <dt>status</dt><dd><StatusBadge status={span.status} /></dd>
        <dt>duration</dt><dd>{fmtMs(span.durationMs)}</dd>
        <dt>startedAt</dt><dd>{span.startedAt}</dd>
        <dt>attributes</dt>
        <dd>
          {Object.keys(span.attributes).length === 0 ? (
            <span className="muted">（空）</span>
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>
              {JSON.stringify(span.attributes, null, 2)}
            </pre>
          )}
        </dd>
      </dl>
    </div>
  );
}
