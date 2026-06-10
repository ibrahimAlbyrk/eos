import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { nextGitMode } from "../lib/composerModes.js";
import { filterOptimistic } from "../lib/optimisticReconcile.js";

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

  // clientMsgId: the idempotency key the send carried — the durable
  // user_message event echoes it back, so reconciliation is by id, not by
  // fragile text matching (unkeyed paths keep the text fallback).
  const addOptimisticUserMessage = useCallback((workerId, text, agentText, clientMsgId = null) => {
    if (!workerId || !text) return null;
    const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, text, agentText: agentText || text, ts: Date.now(), clientMsgId };
    setOptimisticMsgs((prev) => {
      const next = new Map(prev);
      const list = next.get(workerId) ? [...next.get(workerId)] : [];
      list.push(entry);
      next.set(workerId, list);
      return next;
    });
    return id;
  }, []);

  // The 202-queued path: the daemon holds the message (pill renders from the
  // server queue) — the optimistic bubble must hand over immediately.
  const removeOptimisticMessage = useCallback((workerId, optId) => {
    if (!workerId || !optId) return;
    setOptimisticMsgs((prev) => {
      const list = prev.get(workerId);
      if (!list) return prev;
      const filtered = list.filter((m) => m.id !== optId);
      if (filtered.length === list.length) return prev;
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(workerId);
      else next.set(workerId, filtered);
      return next;
    });
  }, []);

  // ids: clientMsgIds from durable user_message events. texts: their texts.
  // failures: delivery_failed previews with their event ts — a failure
  // recorded AFTER the optimistic send means that send died; drop it so the
  // red delivery line isn't shadowed by a forever-pinned optimistic bubble.
  const reconcileOptimisticMessages = useCallback((workerId, { ids, texts, failures = [] }) => {
    if (!workerId) return;
    setOptimisticMsgs((prev) => {
      if (!prev.has(workerId)) return prev;
      const list = prev.get(workerId);
      const filtered = filterOptimistic(list, { ids, texts, failures, now: Date.now() });
      if (filtered.length === list.length) return prev;
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(workerId);
      else next.set(workerId, filtered);
      return next;
    });
  }, []);

  // Agent deleted → its optimistic entries must not outlive it (they used to
  // sit in the Map until app relaunch).
  const purgeAgentMessages = useCallback((workerId) => {
    setOptimisticMsgs((prev) => {
      if (!prev.has(workerId)) return prev;
      const next = new Map(prev);
      next.delete(workerId);
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    composer, updateComposer, toggleGitMode,
    optimisticMsgs, addOptimisticUserMessage, removeOptimisticMessage,
    reconcileOptimisticMessages, purgeAgentMessages,
  }), [
    composer, optimisticMsgs,
    updateComposer, toggleGitMode, addOptimisticUserMessage, removeOptimisticMessage,
    reconcileOptimisticMessages, purgeAgentMessages,
  ]);

  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

export function useComposer() {
  const c = useContext(ComposerContext);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
