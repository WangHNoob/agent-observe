import type { Span } from "../api/observe";
import { StatusBadge, fmtMs } from "./Atoms";

/** JSON 字符串美化（解析失败原样返回）。 */
function prettyJson(v: unknown): string {
  if (typeof v !== "string") return String(v);
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

/** 对象数组 → HTML 表格（列取首行键）。 */
function RowsTable({ rows, title }: { rows: Record<string, unknown>[]; title?: string }) {
  const keys = rows.length > 0 ? Object.keys(rows[0]!) : [];
  if (keys.length === 0) return <div className="muted">（空）</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      {title ? <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{title}</div> : null}
      <table className="data">
        <thead>
          <tr>
            {keys.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} className="mono" style={{ fontSize: 12 }}>{String(row[k] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 工具出参：按知识包形状渲染（表格 / 命中列表 / 文本 / JSON）。 */
function ToolResultView({ value }: { value: string }) {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    return <div className="output-box">{value}</div>;
  }

  const obj = parsed as Record<string, unknown>;
  const result = obj?.result as Record<string, unknown> | undefined;

  // 表格形状：result.rows 为对象数组
  if (Array.isArray(result?.rows) && result.rows.length > 0) {
    const rows = result.rows as Record<string, unknown>[];
    return (
      <RowsTable
        rows={rows}
        title={`${String(result.table ?? "table")} · ${rows.length} 行${result.total ? ` / 共 ${String(result.total)} 行` : ""}`}
      />
    );
  }

  // 搜索命中：result.hits
  if (Array.isArray(result?.hits)) {
    const hits = result.hits as Record<string, unknown>[];
    return (
      <div>
        {hits.slice(0, 30).map((h, i) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <div>
              <span className="mono" style={{ fontSize: 12.5 }}>{String(h.title ?? h.id ?? h.artifactId ?? `#${i + 1}`)}</span>
              {h.score != null ? <span className="badge neutral" style={{ marginLeft: 8 }}>score {String(h.score)}</span> : null}
            </div>
            {h.snippet ? <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{String(h.snippet)}</div> : null}
          </div>
        ))}
        {hits.length > 30 ? <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>… 共 {hits.length} 条命中</div> : null}
      </div>
    );
  }

  // 文档内容：result.content / text
  const content = result?.content ?? result?.text;
  if (typeof content === "string" && content.length > 0) {
    return (
      <>
        {result?.title ? <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{String(result.title)}</div> : null}
        <div className="output-box">{content}</div>
      </>
    );
  }

  // 其他：pretty JSON
  return <div className="output-box">{JSON.stringify(parsed, null, 2)}</div>;
}

/** 已知观测属性 → 结构化展示；其余进通用 JSON。 */
function KnownSections({ attributes }: { attributes: Record<string, unknown> }) {
  const sections: { title: string; body: string; kind?: "tool" | "reasoning" | "output" }[] = [];

  if (attributes.toolArguments != null) {
    sections.push({ title: "工具入参", body: prettyJson(attributes.toolArguments), kind: "tool" });
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
          {s.kind === "tool" && s.title === "工具出参" ? (
            <ToolResultView value={s.body} />
          ) : (
            <div className={`output-box${s.kind === "output" ? " result" : ""}`} style={{ maxHeight: 220 }}>
              {s.body}
            </div>
          )}
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
