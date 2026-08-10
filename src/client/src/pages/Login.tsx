import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { login } from "../api/observe";

export function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-box card">
        <div className="brand">
          <span className="dot" aria-hidden />
          agent-observe
        </div>
        <div className="sub">
          Agent 全链路观测台 — 只读直连共享库，单管理员入口
        </div>
        <form onSubmit={submit}>
          <input
            type="password"
            placeholder="管理员密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            aria-label="管理员密码"
          />
          {error ? <div className="err" role="alert">{error}</div> : null}
          <button className="btn" type="submit" disabled={busy || !password}>
            {busy ? "登录中…" : "进入观测台"}
          </button>
        </form>
      </div>
    </div>
  );
}
