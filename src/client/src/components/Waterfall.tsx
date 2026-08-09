import { AlertCircle, Bot, Brain, Sparkles, Wrench } from "lucide-react";
import type { Span } from "../api/observe";
import { fmtMs } from "./Atoms";

/** 九态 phase 配色（reasoning=蓝 / tool=琥珀 / agent=紫 / summary=青 / error=红） */
const PHASE_COLORS: Record<string, string> = {
  pre_reasoning: "#4c7dff",
  post_reasoning: "#7fa8ff",
  pre_tool_execution: "#e8a33d",
  post_tool_execution: "#f0b95f",
  pre_agent_call: "#a78bfa",
  post_agent_call: "#c4b5fd",
  pre_summary: "#2dd4bf",
  post_summary: "#5eead4",
  on_error: "#f26d6d",
};
const DEFAULT_COLOR = "#64748b";

/** 行背景色调：让"思考–行动节律"在瀑布上形成连续的相位轨道 */
const PHASE_TINT: Record<string, string> = {
  pre_reasoning: "rgba(76, 125, 255, 0.055)",
  post_reasoning: "rgba(76, 125, 255, 0.055)",
  pre_tool_execution: "rgba(232, 163, 61, 0.06)",
  post_tool_execution: "rgba(232, 163, 61, 0.06)",
  pre_agent_call: "rgba(167, 139, 250, 0.07)",
  post_agent_call: "rgba(167, 139, 250, 0.07)",
  pre_summary: "rgba(45, 212, 191, 0.055)",
  post_summary: "rgba(45, 212, 191, 0.055)",
};

interface PhaseMeta {
  color: string;
  tint: string;
  glyph: React.ReactNode;
  legend: string;
}

function phaseMeta(span: Span): PhaseMeta {
  if (span.status === "error") {
    return { color: "#f26d6d", tint: "rgba(242,109,109,0.07)", glyph: <AlertCircle size={12} />, legend: "错误" };
  }
  const phase = span.phase ?? "";
  if (phase.includes("reasoning")) {
    return { color: PHASE_COLORS[phase] ?? "#4c7dff", tint: PHASE_TINT[phase] ?? "", glyph: <Brain size={12} />, legend: "思考" };
  }
  if (phase.includes("tool")) {
    return { color: PHASE_COLORS[phase] ?? "#e8a33d", tint: PHASE_TINT[phase] ?? "", glyph: <Wrench size={12} />, legend: "工具" };
  }
  if (phase.includes("agent_call")) {
    return { color: PHASE_COLORS[phase] ?? "#a78bfa", tint: PHASE_TINT[phase] ?? "", glyph: <Bot size={12} />, legend: "子 Agent" };
  }
  if (phase.includes("summary")) {
    return { color: PHASE_COLORS[phase] ?? "#2dd4bf", tint: PHASE_TINT[phase] ?? "", glyph: <Sparkles size={12} />, legend: "收束" };
  }
  return { color: DEFAULT_COLOR, tint: "", glyph: <span style={{ width: 8, height: 8, borderRadius: 2, background: DEFAULT_COLOR, display: "inline-block" }} />, legend: "其他" };
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
    <>
      <div className="wf-legend">
        <span><i style={{ background: "#4c7dff" }} />思考</span>
        <span><i style={{ background: "#e8a33d" }} />工具</span>
        <span><i style={{ background: "#a78bfa" }} />子 Agent</span>
        <span><i style={{ background: "#2dd4bf" }} />收束</span>
        <span><i style={{ background: "#f26d6d" }} />错误</span>
      </div>
      <div className="waterfall">
        {rows.map(({ span, depth }) => {
          const start = Date.parse(span.startedAt);
          const dur = Math.max(span.durationMs, 0);
          const left = ((start - minStart) / total) * 100;
          const width = Math.max((dur / total) * 100, 0.4);
          const meta = phaseMeta(span);
          return (
            <div
              key={span.id}
              className={`wf-row${selectedId === span.id ? " selected" : ""}`}
              style={meta.tint ? { background: meta.tint } : undefined}
              onClick={() => onSelect(span)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(span);
                }
              }}
              role="button"
              tabIndex={0}
              title={`${meta.legend} · ${span.name}`}
              aria-pressed={selectedId === span.id}
            >
              <div className="wf-label" style={{ paddingLeft: depth * 14 }}>
                <span className="wf-glyph" style={{ color: meta.color }}>{meta.glyph}</span>
                {span.name}
              </div>
              <div className="wf-track">
                <div
                  className="wf-bar"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: meta.color,
                    boxShadow: span.status === "error" ? "0 0 7px rgba(242,109,109,0.7)" : undefined,
                  }}
                />
              </div>
              <div className="wf-dur">{fmtMs(dur)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
