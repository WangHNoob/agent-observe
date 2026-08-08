import type { Span } from "../api/observe";
import { StatusBadge, fmtMs } from "./Atoms";

/** 已知观测属性 → 结构化展示；其余进通用 JSON。 */
function KnownSections({ attributes }: { attributes: Record<string, unknown> }) {
  const sections: { title: string; body: string; kind?: "tool" | "reasoning" | "output" }[] = [];

  if (attributes.toolArguments != null) {
    sections.push({ title: "工具入参", body: String(attributes.toolArguments), kind: "tool" });
  }
  if (attributes.toolResult != null) {
    sections.push({ title: "工具出参", body: String(attributes.toolResult), kind: "tool" });
  }
  if (attributes.llmReasoning != null) {
    sections.push({ title: "LLM 思考", body: String(attributes.llmReasoning), kind: "reasoning" });
  }
  if (attributes.llmOutput != null) {
    sections.push({ title: "LLM 输出", body: String(attributes.llmOutput), kind: "output" });
  }

  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((s) => (
        <div key={s.title} style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            {s.title}
            {s.kind === "reasoning" ? "（reasoning_content）" : ""}
          </div>
          <div className={`output-box${s.kind === "output" ? " result" : ""}`} style={{ maxHeight: 220 }}>
            {s.body}
          </div>
        </div>
      ))}
    </>
  );
}

/** span 属性面板（瀑布图点击后展示），trace 详情与执行详情共用。 */
export function SpanInspector({ span }: { span: Span }) {
  const { toolArguments, toolResult, llmReasoning, llmOutput, inputTokens, outputTokens, ...rest } =
    span.attributes;
  const tokenLine =
    inputTokens != null || outputTokens != null
      ? `in ${String(inputTokens ?? 0)} / out ${String(outputTokens ?? 0)}`
      : null;

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
        {tokenLine ? <dt>tokens</dt> : null}
        {tokenLine ? <dd className="mono">{tokenLine}</dd> : null}
      </dl>
      <KnownSections attributes={span.attributes} />
      {Object.keys(rest).length > 0 ? (
        <>
          <div className="muted" style={{ fontSize: 12, margin: "10px 0 4px" }}>其他属性</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>
            {JSON.stringify(rest, null, 2)}
          </pre>
        </>
      ) : null}
    </div>
  );
}
