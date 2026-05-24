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

  const updateComposer = useCallback((patch) => {
    setComposer((c) => ({ ...c, ...patch }));
  }, []);

  const addOptimisticUserMessage = useCallback((workerId, text) => {
    if (!workerId || !text) return null;
    const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, text, ts: Date.now() };
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
        for (const st of serverTexts) {
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
    optimisticMsgs, addOptimisticUserMessage, reconcileOptimisticMessages,
    drafts, createDraft, updateDraft, removeDraft,
  }), [
    composer, optimisticMsgs, drafts,
    updateComposer, addOptimisticUserMessage, reconcileOptimisticMessages,
    createDraft, updateDraft, removeDraft,
  ]);

  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

export function useComposer() {
  const c = useContext(ComposerContext);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
