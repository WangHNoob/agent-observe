import { useEffect, useState } from "react";
import { ensureRole, getRole } from "../api/http";

/**
 * 当前登录角色（"admin" | "viewer"），未解析时为 null。
 * null 按「非管理员」处理：管理控件先隐藏，role 到位后再出现（fail-safe）。
 */
export function useRole(): "admin" | "viewer" | null {
  const [role, setRoleState] = useState<"admin" | "viewer" | null>(() => {
    const r = getRole();
    return r === "admin" || r === "viewer" ? r : null;
  });

  useEffect(() => {
    let alive = true;
    void ensureRole().then((r) => {
      if (!alive) return;
      setRoleState(r === "admin" || r === "viewer" ? r : null);
    });
    return () => {
      alive = false;
    };
  }, []);

  return role;
}
