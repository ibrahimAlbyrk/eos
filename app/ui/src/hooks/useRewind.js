import { useCallback } from "react";
import { api } from "../api/client.js";
import { useUi } from "../state/ui.jsx";
import { findRewindTarget } from "../lib/rewindMatch.js";

// One-click message rewind: resolves a chat bubble to its transcript target
// and drives the same backend choreography as the double-Esc RewindPanel
// (conversation-only restore; the restored prompt lands in the composer).
export function useRewind(workerId) {
  const ui = useUi();

  return useCallback(async (text, occurrence = 0) => {
    const r = await api.getRewindTargets(workerId);
    if (!r.ok || !Array.isArray(r.body?.targets)) {
      return { ok: false, error: r.body?.error || "couldn't load messages" };
    }
    const target = findRewindTarget(r.body.targets, text, occurrence);
    if (!target) return { ok: false, error: "message not found on the active branch" };
    const res = await api.rewindWorker(workerId, target.uuid, "conversation");
    if (res.ok && res.body?.ok) {
      ui.updateComposer({ pendingText: { content: res.body.display || res.body.text || "", ts: Date.now() } });
      return { ok: true };
    }
    return { ok: false, error: res.body?.error || `rewind failed (${res.status})` };
  }, [workerId, ui.updateComposer]);
}
