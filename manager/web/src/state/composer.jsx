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

  // Outbound message bubbles/pills live in state/outboxStore.js — the single
  // owner of the send lifecycle (Composer, Messages and useLive all touch it,
  // and they don't share a subtree below this provider).

  const value = useMemo(() => ({
    composer, updateComposer, toggleGitMode,
  }), [composer, updateComposer, toggleGitMode]);

  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

export function useComposer() {
  const c = useContext(ComposerContext);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
