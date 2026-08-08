import { Activity, LayoutDashboard, LogOut, ListTree } from "lucide-react";
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
          <span className="dot" />
          agent-observe
        </div>
        <NavLink to="/" end className={({ isActive }) => (isActive ? "nav active" : "nav")}>
          <LayoutDashboard size={16} />
          总览
        </NavLink>
        <NavLink to="/traces" className={({ isActive }) => (isActive ? "nav active" : "nav")}>
          <ListTree size={16} />
          Trace 列表
        </NavLink>
        <div className="spacer" />
        <button className="logout" onClick={logout}>
          <LogOut size={15} />
          退出登录
        </button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1>{title}</h1>
      {subtitle ? <div className="subtitle">{subtitle}</div> : null}
    </>
  );
}

export function ActivityPulse() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", color: "var(--ok)" }}>
      <Activity size={13} style={{ marginRight: 6 }} />
      <span className="mono" style={{ color: "var(--text-dim)" }}>
        design-agent 共享库
      </span>
    </span>
  );
}
