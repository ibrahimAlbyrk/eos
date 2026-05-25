import { createContext, useCallback, useContext, useMemo, useState } from "react";

const ComposerContext = createContext(null);

const DEFAULT_COMPOSER = {
  cwd: null,
  branch: null,
  worktree: false,
  model: "opus",
  effort: "high",
  permissionMode: "acceptEdits",
};

export function ComposerProvider({ children }) {
  const [composer, setComposer] = useState(DEFAULT_COMPOSER);
  const [optimisticMsgs, setOptimisticMsgs] = useState(() => new Map());
  const [drafts, setDrafts] = useState(() => new Map());
  const [queuedMessages, setQueuedMessages] = useState(() => new Map());
  const [restoreText, setRestoreText] = useState(null);
  const [undoWorkerId, setUndoWorkerId] = useState(null);

  const updateComposer = useCallback((patch) => {
    setComposer((c) => ({ ...c, ...patch }));
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

  const reconcileOptimisticMessages = useCallback((workerId, serverTexts) => {
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

  const removeLastOptimisticMessage = useCallback((workerId) => {
    setOptimisticMsgs((prev) => {
      const list = prev.get(workerId);
      if (!list || list.length === 0) return prev;
      const next = new Map(prev);
      const remaining = list.slice(0, -1);
      if (remaining.length === 0) next.delete(workerId);
      else next.set(workerId, remaining);
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

  const createDraft = useCallback((name) => {
    const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(id, {
        name: name || "",
        cwd: null,
        branch: null,
        worktree: false,
        model: DEFAULT_COMPOSER.model,
        effort: DEFAULT_COMPOSER.effort,
        permissionMode: DEFAULT_COMPOSER.permissionMode,
        createdAt: Date.now(),
      });
      return next;
    });
    return id;
  }, []);

  const updateDraft = useCallback((id, patch) => {
    setDrafts((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, { ...prev.get(id), ...patch });
      return next;
    });
  }, []);

  const removeDraft = useCallback((id) => {
    setDrafts((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    composer, updateComposer,
    optimisticMsgs, addOptimisticUserMessage, reconcileOptimisticMessages, removeLastOptimisticMessage,
    drafts, createDraft, updateDraft, removeDraft,
    queuedMessages, addQueuedMessage, removeQueuedMessage, clearQueuedMessages,
    restoreText, setRestoreText,
    undoWorkerId, setUndoWorkerId,
  }), [
    composer, optimisticMsgs, drafts, queuedMessages, restoreText, undoWorkerId,
    updateComposer, addOptimisticUserMessage, reconcileOptimisticMessages, removeLastOptimisticMessage,
    createDraft, updateDraft, removeDraft,
    addQueuedMessage, removeQueuedMessage, clearQueuedMessages, setRestoreText, setUndoWorkerId,
  ]);

  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

export function useComposer() {
  const c = useContext(ComposerContext);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
