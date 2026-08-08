import { fmtMs } from "./Atoms";
import type { Span } from "../api/observe";

/** 九态 phase 配色（与设计-agent TracingHook 的 phase 枚举对齐） */
const PHASE_COLORS: Record<string, string> = {
  pre_reasoning: "#60a5fa",
  post_reasoning: "#93c5fd",
  pre_tool_execution: "#f59e0b",
  post_tool_execution: "#fbbf24",
  pre_agent_call: "#a78bfa",
  post_agent_call: "#c4b5fd",
  pre_summary: "#2dd4bf",
  post_summary: "#5eead4",
  on_error: "#f87171",
};
const DEFAULT_COLOR = "#64748b";

function spanColor(span: Span): string {
  if (span.phase && PHASE_COLORS[span.phase]) return PHASE_COLORS[span.phase];
  // guard / plan / tool 韧性类 span 走中性色，error 态统一红色
  if (span.status === "error") return "#f87171";
  return DEFAULT_COLOR;
}

interface WaterfallProps {
  spans: Span[];
  selectedId: string | null;
  onSelect: (span: Span) => void;
}

interface Row {
  span: Span;
  depth: number;
}

export function Waterfall({ spans, selectedId, onSelect }: WaterfallProps) {
  if (!spans.length) {
    return <div className="empty">该 trace 没有 span 记录</div>;
  }

  const times = spans.map((s) => [Date.parse(s.startedAt), Date.parse(s.endedAt)] as const);
  const minStart = Math.min(...times.map(([a]) => a));
  const maxEnd = Math.max(...times.map(([, b]) => b));
  const total = Math.max(maxEnd - minStart, 1);

  // 按 parent 建树（parent 缺失或不在集合内视为根）
  const ids = new Set(spans.map((s) => s.id));
  const children = new Map<string | null, Span[]>();
  for (const s of spans) {
    const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    const list = children.get(parent) ?? [];
    list.push(s);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      rows.push({ span, depth });
      walk(span.id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <div className="waterfall">
      {rows.map(({ span, depth }) => {
        const start = Date.parse(span.startedAt);
        const dur = Math.max(span.durationMs, 0);
        const left = ((start - minStart) / total) * 100;
        const width = Math.max((dur / total) * 100, 0.4);
        const color = spanColor(span);
        return (
          <div
            key={span.id}
            className={`wf-row${selectedId === span.id ? " selected" : ""}`}
            onClick={() => onSelect(span)}
          >
            <div className="wf-label" style={{ paddingLeft: depth * 14 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: color,
                  marginRight: 8,
                }}
              />
              {span.name}
            </div>
            <div className="wf-track">
              <div
                className="wf-bar"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background: color,
                  boxShadow: span.status === "error" ? "0 0 6px rgba(248,113,113,0.8)" : undefined,
                  border: span.status === "error" ? "1px solid #f87171" : undefined,
                }}
              />
            </div>
            <div className="wf-dur">{fmtMs(dur)}</div>
          </div>
        );
      })}
    </div>
  );
}
