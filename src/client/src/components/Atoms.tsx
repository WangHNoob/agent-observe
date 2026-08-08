/** 通用原子组件：状态徽标 / 空态 / 加载态 / 时长格式化 */

export function StatusBadge({ status }: { status: string }) {
  const cls = ["ok", "error", "unset"].includes(status) ? status : "neutral";
  return (
    <span className={`badge ${cls}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function Spin() {
  return <div className="spin">加载中…</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div className="empty" style={{ color: "var(--error)" }}>加载失败：{message}</div>;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;
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

/** 时长毫秒 → 人类可读 */
export function fmtMicrosCost(micros: string): string {
  const v = Number(micros);
  if (!v) return "0";
  return `$${(v / 1_000_000).toFixed(4)}`;
}
