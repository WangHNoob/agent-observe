import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchOverview } from "../api/observe";
import { Empty, ErrorBox, Spin, fmtMs, fmtTime, fmtTokens } from "../components/Atoms";
import { ActivityPulse, PageHeader } from "../components/Layout";

const HOURS = 24;

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: fetchOverview,
    refetchInterval: 30_000,
  });

  if (isLoading) return <Spin />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty text="暂无数据" />;

  const maxN = Math.max(...data.trend.map((t) => t.n), 1);
  const tokens = data.inputTokens + data.outputTokens;

  return (
    <>
      <PageHeader title="总览" subtitle={<ActivityPulse />} />

      <div className="stat-grid">
        <Stat label={`近 ${HOURS}h Trace`} value={String(data.tracesTotal)} hint={`ok ${data.tracesOk} · error ${data.tracesError}`} />
        <Stat label="错误率" value={`${data.errorRate}%`} danger={data.errorRate > 20} />
        <Stat label="平均时长" value={fmtMs(data.avgDurationMs)} small />
        <Stat label="P50 时长" value={fmtMs(data.p50DurationMs)} small />
        <Stat label="Token（in+out）" value={fmtTokens(tokens)} small hint={`in ${fmtTokens(data.inputTokens)} / out ${fmtTokens(data.outputTokens)}`} />
        <Stat label="最慢单次" value={fmtMs(data.maxDurationMs)} small />
      </div>

      <div className="card">
        <h2>近 24h Trace 趋势（逐小时）</h2>
        <div className="trend">
          {data.trend.map((t) => {
            const h = new Date(t.bucket + "Z").getHours();
            return (
              <div className="col" key={t.bucket} title={`${t.bucket}Z · ${t.n} 条（${t.errors} 错误）`}>
                <div className="bar" style={{ height: `${Math.max((t.n / maxN) * 100, 2)}%` }} />
                {t.errors > 0 ? <div className="bar err" style={{ height: `${Math.max((t.errors / maxN) * 100, 2)}%` }} /> : null}
                <div className="tick">{String(h).padStart(2, "0")}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <h2>按模式</h2>
          {data.modeBreakdown.length === 0 ? (
            <Empty text="暂无数据" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>模式</th><th className="num">次数</th><th className="num">错误</th></tr>
              </thead>
              <tbody>
                {data.modeBreakdown.map((m) => (
                  <tr key={m.mode}>
                    <td><Link to={`/traces?mode=${m.mode}`}>{m.mode}</Link></td>
                    <td className="num">{m.n}</td>
                    <td className="num" style={{ color: m.errors ? "var(--error)" : undefined }}>{m.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>最近错误 Trace</h2>
          {data.recentErrors.length === 0 ? (
            <Empty text="近 24h 无错误" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>时间</th><th>名称</th><th className="num">时长</th></tr>
              </thead>
              <tbody>
                {data.recentErrors.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{fmtTime(t.startedAt)}</td>
                    <td><Link to={`/traces/${t.id}`}>{t.name}</Link></td>
                    <td className="num">{fmtMs(t.durationMs)}</td>
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

function Stat({ label, value, hint, small, danger }: { label: string; value: string; hint?: string; small?: boolean; danger?: boolean }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value${small ? " small" : ""}`} style={danger ? { color: "var(--error)" } : undefined}>{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
