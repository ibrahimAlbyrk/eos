import { useCallback, useState } from "react";
import { api } from "../api/client.js";
import { peekBootPart } from "../api/boot.js";
import { ROUTES } from "../api/routes.js";
import { notify } from "../lib/notify.js";

export function usePendingPermissions(scheduleRefetch) {
  // At start-up the open asks come from the boot snapshot (useLive's first load takes
  // the same answer).
  const [pendingPermissions, setPendingPermissions] = useState(() => {
    const asks = peekBootPart(ROUTES.pending);
    return Array.isArray(asks) ? asks : [];
  });

  const approvePending = useCallback(async (id) => {
    await api.approvePending(id);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  const alwaysAllowPending = useCallback(async (id, toolName, _workerId) => {
    await api.approvePending(id);
    try {
      const res = await api.addPolicyRule(toolName, "allow");
      if (!res?.ok) {
        const reason = res?.body?.error ? `: ${res.body.error}` : "";
        notify.error(`Couldn't save "always allow" for ${toolName}${reason}`, { title: "Permissions" });
      }
    } catch (e) {
      notify.error(`Couldn't save "always allow" for ${toolName}: ${e instanceof Error ? e.message : String(e)}`, { title: "Permissions" });
    }
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
