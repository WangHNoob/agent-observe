import { Activity, ClipboardList, LayoutDashboard, ListTree, LogOut } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { clearToken } from "../api/http";

export function Layout() {
  const navigate = useNavigate();
  const logout = () => {
    clearToken();
    navigate("/login");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" aria-hidden />
          agent-observe
        </div>
        <div className="nav-section">导航</div>
        <NavLink to="/" end className={({ isActive }) => (isActive ? "nav active" : "nav")}>
          <LayoutDashboard size={16} strokeWidth={1.75} />
          总览
        </NavLink>
        <NavLink to="/traces" className={({ isActive }) => (isActive ? "nav active" : "nav")}>
          <ListTree size={16} strokeWidth={1.75} />
          Trace 列表
        </NavLink>
        <NavLink to="/eval-candidates" className={({ isActive }) => (isActive ? "nav active" : "nav")}>
          <ClipboardList size={16} strokeWidth={1.75} />
          评测候选池
        </NavLink>
        <div className="spacer" />
        <div className="side-meta">
          <span className="live-dot" aria-hidden /> 只读观测 · JWT
        </div>
        <button type="button" className="logout" onClick={logout}>
          <LogOut size={15} strokeWidth={1.75} />
          退出登录
        </button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  backTo,
  backLabel = "返回",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="page-toolbar">
      <div>
        {backTo ? (
          <NavLink to={backTo} className="back-link">
            ← {backLabel}
          </NavLink>
        ) : null}
        <h1>{title}</h1>
        {subtitle ? <div className="subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </div>
  );
}

export function ActivityPulse() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="live-dot" aria-hidden />
      <Activity size={13} style={{ color: "var(--ok)" }} />
      <span className="mono" style={{ color: "var(--text-dim)" }}>
        design-agent 共享库 · 30s 刷新
      </span>
    </span>
  );
}
