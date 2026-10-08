import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getToken } from "./api/http";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { ExecutionDetail } from "./pages/ExecutionDetail";
import { Login } from "./pages/Login";
import { TraceDetail } from "./pages/TraceDetail";
import { TraceList } from "./pages/TraceList";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/traces" element={<TraceList />} />
        <Route path="/traces/:id" element={<TraceDetail />} />
        <Route path="/executions/:id" element={<ExecutionDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
