import { AlertCircle, Copy, Inbox } from "lucide-react";
import { useState } from "react";

/** 通用原子组件：状态徽标 / 空态 / 加载态 / 时长格式化 / 复制 */

export function StatusBadge({ status }: { status: string }) {
  const cls = ["ok", "error", "unset"].includes(status) ? status : "neutral";
  return (
    <span className={`badge ${cls}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>
        <Inbox size={18} strokeWidth={1.75} />
      </div>
      <div className="empty-title">{text}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
    </div>
  );
}

export function Spin({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="spin" role="status" aria-live="polite">
      <div className="spin-ring" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="empty-state">
      <div className="empty-icon" style={{ background: "rgba(242,109,109,0.12)", color: "var(--error)", borderColor: "rgba(242,109,109,0.25)" }} aria-hidden>
        <AlertCircle size={18} />
      </div>
      <div className="empty-title" style={{ color: "var(--error)" }}>加载失败</div>
      <div className="empty-hint mono">{message}</div>
    </div>
  );
}

export function CopyId({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };
  return (
    <span className="id-chip">
      {label ? <b>{label}</b> : null}
      <span className="mono" title={value}>{value}</span>
      <button
        type="button"
        className={`copy-btn${copied ? " copied" : ""}`}
        onClick={copy}
        title={copied ? "已复制" : "复制"}
        aria-label={copied ? "已复制" : `复制 ${label ?? "ID"}`}
      >
        <Copy size={11} />
        {copied ? "已复制" : ""}
      </button>
    </span>
  );
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

/** 微美元成本 → 可读美元 */
export function fmtMicrosCost(micros: string): string {
  const v = Number(micros);
  if (!v) return "0";
  return `$${(v / 1_000_000).toFixed(4)}`;
}
