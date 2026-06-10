import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { nextGitMode } from "../lib/composerModes.js";

const ComposerContext = createContext(null);

const DEFAULT_COMPOSER = {
  cwd: null,
  branch: null,
  model: "opus",
  effort: "xhigh",
  permissionMode: "acceptEdits",
  gitMode: false,
  // `!` on an empty input flips the composer into terminal mode: Enter runs
  // the text as a daemon-side bash command instead of messaging the agent.
  termMode: false,
  // {content, ts} queued by the template picker / ⌘K palette; the Composer
  // consumes it (inserts text + selects the first {{placeholder}}) and clears.
  pendingTemplate: null,
  // {content, ts} queued by the rewind panel — the restored prompt; the
  // Composer consumes it (replaces the input, cursor at end) and clears.
  pendingText: null,
};

export function ComposerProvider({ children }) {
  const [composer, setComposer] = useState(DEFAULT_COMPOSER);
  const [optimisticMsgs, setOptimisticMsgs] = useState(() => new Map());
  const [queuedMessages, setQueuedMessages] = useState(() => new Map());

  const updateComposer = useCallback((patch) => {
    setComposer((c) => ({ ...c, ...patch }));
  }, []);

  // Single source of truth for the git ("custom task") mode flip. `on`
  // undefined toggles; the git button / startCustom / Cmd+G all route here.
  const toggleGitMode = useCallback((on) => {
    setComposer((c) => {
      const next = nextGitMode(c, on);
      return next === c.gitMode ? c : { ...c, gitMode: next };
    });
  }, []);

  const addOptimisticUserMessage = useCallback((workerId, text, agentText) => {
    if (!workerId || !text) return null;
    const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, text, agentText: agentText || text, ts: Date.now() };
    setOptimisticMsgs((prev) => {
      const next = new Map(prev);
      const list = next.get(workerId) ? [...next.get(workerId)] : [];
      list.push(entry);
      next.set(workerId, list);
      return next;
    });
    return id;
  }, []);

  // serverTexts: durable user_message texts (delivered → drop the optimistic
  // copy). failures: delivery_failed previews with their event ts — a failure
  // recorded AFTER the optimistic send means that send died; drop it so the
  // red delivery line isn't shadowed by a forever-pinned optimistic bubble.
  const reconcileOptimisticMessages = useCallback((workerId, serverTexts, failures = []) => {
    if (!workerId) return;
    setOptimisticMsgs((prev) => {
      if (!prev.has(workerId)) return prev;
      const list = prev.get(workerId);
      const filtered = list.filter((m) => {
        const mAgent = m.agentText || m.text;
        for (const st of serverTexts) {
          if (mAgent === st || st.startsWith(mAgent) || mAgent.startsWith(st)) return false;
          if (m.text === st || st.startsWith(m.text) || m.text.startsWith(st)) return false;
        }
        for (const f of failures) {
          // f.text is a 120-char preview of the text sent to the PTY.
          if (f.ts >= m.ts && (mAgent === f.text || mAgent.startsWith(f.text))) return false;
        }
        return true;
      });
      if (filtered.length === list.length) return prev;
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(workerId);
      else next.set(workerId, filtered);
      return next;
    });
  }, []);

  const addQueuedMessage = useCallback((workerId, text) => {
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setQueuedMessages((prev) => {
      const next = new Map(prev);
      const list = next.get(workerId) ?? [];
      next.set(workerId, [...list, { id, text, ts: Date.now() }]);
      return next;
    });
    return id;
  }, []);

  const removeQueuedMessage = useCallback((workerId, msgId) => {
    setQueuedMessages((prev) => {
      const list = prev.get(workerId);
      if (!list) return prev;
      const filtered = list.filter((m) => m.id !== msgId);
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(workerId);
      else next.set(workerId, filtered);
      return next;
    });
  }, []);

  const clearQueuedMessages = useCallback((workerId) => {
    setQueuedMessages((prev) => {
      if (!prev.has(workerId)) return prev;
      const next = new Map(prev);
      next.delete(workerId);
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    composer, updateComposer, toggleGitMode,
    optimisticMsgs, addOptimisticUserMessage, reconcileOptimisticMessages,
    queuedMessages, addQueuedMessage, removeQueuedMessage, clearQueuedMessages,
  }), [
    composer, optimisticMsgs, queuedMessages,
    updateComposer, toggleGitMode, addOptimisticUserMessage, reconcileOptimisticMessages,
    addQueuedMessage, removeQueuedMessage, clearQueuedMessages,
  ]);

  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

export function useComposer() {
  const c = useContext(ComposerContext);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
