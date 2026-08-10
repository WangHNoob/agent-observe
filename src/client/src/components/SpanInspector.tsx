import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSpan, type Span } from "../api/observe";
import { ErrorBox, Spin, StatusBadge, fmtMs } from "./Atoms";

/** 转义 + JSON 语法着色（键/字符串/数字/布尔），返回 HTML 片段。 */
function jsonHighlight(raw: string): string {
  const esc = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "jv-num";
      if (match.startsWith('"')) {
        cls = /:$/.test(match) ? "jv-key" : "jv-str";
      } else if (/true|false|null/.test(match)) {
        cls = "jv-bool";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

function RawJson({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open ? jsonHighlight(value) : ""), [open, value]);

  return (
    <details
      className="collapse"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>查看原始 JSON（{value.length.toLocaleString()} 字符）</summary>
      {open ? (
        value.length > 80_000 ? (
          <pre className="raw-json">{value}</pre>
        ) : (
          <pre className="raw-json" dangerouslySetInnerHTML={{ __html: html }} />
        )
      ) : null}
    </details>
  );
}

/** 对象数组 → HTML 表格（列取首行键，表头吸顶）。大结果截断避免卡顿。 */
function RowsTable({ rows, title }: { rows: Record<string, unknown>[]; title?: string }) {
  const keys = rows.length > 0 ? Object.keys(rows[0]!) : [];
  if (keys.length === 0) return <div className="muted">（空）</div>;
  const shown = rows.slice(0, 100);
  return (
    <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
      {title ? <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{title}</div> : null}
      <table className="data">
        <thead>
          <tr>
            {keys.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} className="mono" style={{ fontSize: 12 }}>{String(row[k] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <div className="muted" style={{ fontSize: 12, padding: "6px 0" }}>
          仅展示前 {shown.length} / {rows.length} 行（完整数据见原始 JSON）
        </div>
      ) : null}
    </div>
  );
}

/** 工具出参：按知识包形状渲染（表格 / 命中列表 / 文本），原始 JSON 折叠可查。 */
function ToolResultView({ value }: { value: string }) {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    return (
      <>
        <div className="output-box">{value}</div>
        {value.includes("…[+") ? <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>结果超长已被截断（外层截断会破坏 JSON 结构，仅保留文本预览）</div> : null}
      </>
    );
  }

  const obj = parsed as Record<string, unknown>;
  const result = obj?.result as Record<string, unknown> | undefined;

  if (Array.isArray(result?.rows) && result.rows.length > 0) {
    const rows = result.rows as Record<string, unknown>[];
    return (
      <>
        <div className="result-meta">
          <span className="badge neutral">{String(result.table ?? "table")}</span>
          <span className="mono muted" style={{ fontSize: 12 }}>
            {rows.length} 行{result.total ? ` / 共 ${String(result.total)} 行` : ""}
          </span>
          {obj.trust ? <span className="badge ok">trust {String((obj.trust as Record<string, unknown>).score ?? "?")}</span> : null}
        </div>
        <RowsTable rows={rows} />
        <RawJson value={value} />
      </>
    );
  }

  if (Array.isArray(result?.hits)) {
    const hits = result.hits as Record<string, unknown>[];
    return (
      <>
        <div className="result-meta">
          <span className="badge neutral">{hits.length} 条命中</span>
          {result.query ? <span className="mono muted" style={{ fontSize: 12 }}>query: {String(result.query)}</span> : null}
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 7 }}>
          {hits.slice(0, 30).map((h, i) => (
            <div key={i} style={{ borderBottom: "1px solid var(--border-soft)", padding: "7px 11px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 12.5 }}>{String(h.title ?? h.id ?? h.artifactId ?? `#${i + 1}`)}</span>
                {h.score != null ? <span className="badge neutral">score {String(h.score)}</span> : null}
              </div>
              {h.snippet ? <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{String(h.snippet)}</div> : null}
            </div>
          ))}
          {hits.length > 30 ? <div className="muted" style={{ fontSize: 12, padding: 8 }}>… 共 {hits.length} 条命中</div> : null}
        </div>
        <RawJson value={value} />
      </>
    );
  }

  const content = result?.content ?? result?.text;
  if (typeof content === "string" && content.length > 0) {
    return (
      <>
        <div className="result-meta">
          {result?.title ? <span className="badge neutral">{String(result.title)}</span> : null}
          {result?.artifactId ? <span className="mono muted" style={{ fontSize: 12 }}>{String(result.artifactId)}</span> : null}
        </div>
        <div className="output-box" style={{ maxHeight: 260 }}>{content}</div>
        <RawJson value={value} />
      </>
    );
  }

  return (
    <>
      <div className="output-box">{JSON.stringify(parsed, null, 2)}</div>
      <RawJson value={value} />
    </>
  );
}

/** 工具入参：单行摘要 + 原始 JSON 折叠。 */
function ToolArgsView({ value }: { value: string }) {
  let compact = value;
  try {
    compact = JSON.stringify(JSON.parse(value));
  } catch {
    compact = value.replace(/\s+/g, " ").trim();
  }
  const line = compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
  return (
    <details className="collapse" style={{ marginTop: 0 }}>
      <summary title="点击展开原始 JSON">{line}</summary>
      <RawJson value={value} />
    </details>
  );
}

/** 已知观测属性 → 结构化展示；其余进通用 JSON。 */
function KnownSections({ attributes }: { attributes: Record<string, unknown> }) {
  const sections: { title: string; kind: "tool" | "reasoning" | "output"; body: string }[] = [];

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
        <div key={s.title} style={{ marginBottom: 14 }}>
          <div className="section-label">
            {s.title}
            {s.kind === "reasoning" ? " · reasoning_content" : ""}
          </div>
          {s.kind === "tool" && s.title === "工具出参" ? (
            <ToolResultView value={s.body} />
          ) : s.kind === "tool" ? (
            <ToolArgsView value={s.body} />
          ) : (
            <div className={`output-box${s.kind === "output" ? " result" : " thought"}`} style={{ maxHeight: 220 }}>
              {s.body}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** span 属性面板：lite spans 时按需拉取完整 attributes；docked 时嵌入右侧工作区。 */
export function SpanInspector({
  span,
  traceId,
  spansLite = false,
  onClose,
  docked = false,
}: {
  span: Span;
  traceId?: string;
  spansLite?: boolean;
  onClose?: () => void;
  docked?: boolean;
}) {
  const needFetch = Boolean(traceId) && spansLite;
  const full = useQuery({
    queryKey: ["span", traceId, span.id],
    queryFn: () => fetchSpan(traceId!, span.id),
    enabled: needFetch,
    staleTime: 60_000,
  });

  const resolved = full.data ?? span;
  const loading = needFetch && full.isLoading;
  const fetchError = needFetch ? full.error : null;

  const { toolArguments, toolResult, llmReasoning, llmOutput, inputTokens, outputTokens, ...rest } =
    resolved.attributes;
  const tokenLine =
    inputTokens != null || outputTokens != null
      ? `in ${String(inputTokens ?? 0)} / out ${String(outputTokens ?? 0)}`
      : null;

  return (
    <div className={docked ? "span-inspector docked" : "card span-inspector"} id="span-inspector">
      <div className="span-inspector-head">
        <span className="badge neutral">{resolved.phase ?? "span"}</span>
        <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{resolved.name}</span>
        <StatusBadge status={resolved.status} />
        <span className="mono muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {fmtMs(resolved.durationMs)}
          {tokenLine ? ` · ${tokenLine}` : ""}
        </span>
        {onClose ? (
          <button type="button" className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={onClose}>
            关闭
          </button>
        ) : null}
      </div>
      {loading ? <Spin label="加载 span 属性…" /> : null}
      {fetchError ? <ErrorBox error={fetchError} /> : null}
      {!loading && !fetchError ? (
        <>
          <KnownSections attributes={resolved.attributes} />
          {Object.keys(rest).length > 0 ? (
            <>
              <div className="section-label" style={{ marginTop: 10 }}>其他属性</div>
              <details className="collapse">
                <summary>查看其他属性（{Object.keys(rest).length} 项）</summary>
                <RawJson value={JSON.stringify(rest, null, 2)} />
              </details>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
