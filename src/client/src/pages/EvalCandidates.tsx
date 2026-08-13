import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchEvalCandidates,
  markEvalCandidateStatus,
  triggerEvalSampling,
  type EvalCandidate,
  type EvalCandidateStatus,
} from "../api/observe";
import { PageHeader } from "../components/Layout";

const SOURCE_LABEL: Record<string, string> = {
  faq_miss: "FAQ 未命中",
  tool_chain: "工具链 ≥ 2",
  plain_query: "普通 query",
};

/**
 * 在线评测候选池（flywheel 03-P4）：
 * 生产 query trace → 判分候选（question + answer + trace 溯源），
 * 人工确认后导出为 knowledge-hub golden case。
 */
export function EvalCandidates() {
  const [candidates, setCandidates] = useState<EvalCandidate[]>([]);
  const [samplingEnabled, setSamplingEnabled] = useState(false);
  const [statusFilter, setStatusFilter] = useState<EvalCandidateStatus | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (status?: EvalCandidateStatus) => {
    try {
      const res = await fetchEvalCandidates({ status, limit: 200 });
      setCandidates(res.candidates);
      setSamplingEnabled(res.samplingEnabled);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(statusFilter);
  }, [load, statusFilter]);

  const runSample = async () => {
    setBusy(true);
    try {
      const res = await triggerEvalSampling();
      setError(`采样完成：${res.sampled} 条（${JSON.stringify(res.bySource)}）`);
      await load(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const mark = async (id: string, status: EvalCandidateStatus) => {
    try {
      await markEvalCandidateStatus(id, status);
      await load(statusFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportJson = () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      note: "观测台在线评测采样候选：人工确认后改写为 knowledge-hub golden case。",
      candidates: candidates.map((c) => ({
        id: c.id,
        question: c.question,
        answer: c.answer,
        traceId: c.traceId,
        executionId: c.executionId,
        mode: c.mode,
        source: c.source,
        createdAt: c.createdAt,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eval-candidates-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <PageHeader
        title="评测候选池"
        subtitle="生产 query trace → 判分候选（question + answer + trace 溯源），导出后改写为 knowledge-hub golden case"
        actions={
          <>
            <button type="button" className="btn" onClick={runSample} disabled={busy || !samplingEnabled}>
              <RefreshCw size={14} strokeWidth={1.75} />
              {busy ? "采样中…" : "立即采样"}
            </button>
            <button type="button" className="btn primary" onClick={exportJson}>
              <Download size={14} strokeWidth={1.75} />
              导出候选
            </button>
          </>
        }
      />
      {!samplingEnabled ? (
        <div className="panel warn">采样写入未启用：OBS_MANAGER_DATABASE_URL 未配置（读取不受影响）。</div>
      ) : null}
      {error ? <div className="panel warn">{error}</div> : null}
      <div className="panel">
        <div className="filter-row">
          {(["pending", "exported", "dismissed"] as const).map((status) => (
            <button
              key={status}
              type="button"
              className={`chip ${statusFilter === status ? "chip-active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === status ? undefined : status)}
            >
              {status}
            </button>
          ))}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>问题</th>
              <th>来源</th>
              <th>模式</th>
              <th>答案片段</th>
              <th>溯源</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.id}>
                <td className="mono" title={candidate.question}>
                  {candidate.question.slice(0, 80)}
                </td>
                <td>{SOURCE_LABEL[candidate.source] ?? candidate.source}</td>
                <td>{candidate.mode}</td>
                <td className="mono dim" title={candidate.answer}>
                  {(candidate.answer || "—").slice(0, 60)}
                </td>
                <td>
                  <a className="link" href={`/traces/${encodeURIComponent(candidate.traceId)}`}>
                    {candidate.traceId.slice(0, 10)}
                  </a>
                </td>
                <td>{candidate.status}</td>
                <td>
                  {candidate.status === "pending" ? (
                    <>
                      <button type="button" className="btn small" onClick={() => void mark(candidate.id, "exported")}>
                        已导出
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => void mark(candidate.id, "dismissed")}>
                        丢弃
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {candidates.length === 0 ? (
              <tr>
                <td colSpan={7} className="dim center">
                  暂无候选（等待采样或调整过滤）
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
