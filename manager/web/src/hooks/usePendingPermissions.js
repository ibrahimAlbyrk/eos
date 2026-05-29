import { useCallback, useState } from "react";
import { api } from "../api/client.js";

export function usePendingPermissions(scheduleRefetch) {
  const [pendingPermissions, setPendingPermissions] = useState([]);

  const approvePending = useCallback(async (id) => {
    await api.approvePending(id);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  const alwaysAllowPending = useCallback(async (id, toolName, _workerId) => {
    await api.approvePending(id);
    await api.addPolicyRule(toolName, "allow").catch(() => {});
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  const denyPending = useCallback(async (id, reason) => {
    await api.denyPending(id, reason);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  return {
    pendingPermissions,
    setPendingPermissions,
    approvePending,
    alwaysAllowPending,
    denyPending,
  };
}
