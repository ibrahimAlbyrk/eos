import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const ComposerContext = createContext(null);

const DEFAULT_COMPOSER = {
  cwd: null,
  branch: null,
  model: "opus",
  effort: "xhigh",
  permissionMode: "acceptEdits",
  // Selected provider NAME from the unified spawn picker (providerChoices):
  // a subscription kind ("claude-sdk" | "claude-cli") or an operator profile
  // name ("deepseek"), seeded from the provider setting. Resolved to
  // backendKind/backendProfile at spawn time (providerSpawn); a same-name operator
  // profile wins so the spawn preserves its config. null → server default.
  provider: null,
  // gitMode / termMode are per-pane now (each pane owns its Composer, so it holds
  // them as local state) — no longer a singleton here. This provider keeps only
  // the spawn config that the no-agent composer consumes.
  // {content, attachments, ts} queued by the template picker / ⌘K palette; the
  // Composer consumes it (re-seats attachment chips, inserts text + selects the
  // first {{placeholder}}) and clears.
  pendingTemplate: null,
  // {content, ts} queued by the rewind panel — the restored prompt; the
  // Composer consumes it (replaces the input, cursor at end) and clears.
  pendingText: null,
  // {paths, ts} queued by the Files panel's "Attach as context" — absolute file
  // paths the Composer inserts at the cursor as @ mentions (same bookkeeping as
  // picking them from the @ menu) and clears.
  pendingMention: null,
};

export function ComposerProvider({ children }) {
  const [composer, setComposer] = useState(DEFAULT_COMPOSER);

  const updateComposer = useCallback((patch) => {
    setComposer((c) => ({ ...c, ...patch }));
  }, []);

  // gitMode is per-pane local state now, so the focused pane's Composer registers
  // its own toggler here (mirrors selection.jsx's registerEscapeGitMode). Cmd+G
  // (useGitModeHotkey) and the git button / startCustom all route through
  // toggleGitMode → the focused composer, never a singleton flag.
  const gitToggleRef = useRef(() => {});
  const registerGitModeToggle = useCallback((fn) => { gitToggleRef.current = fn ?? (() => {}); }, []);
  const toggleGitMode = useCallback((on) => { gitToggleRef.current(on); }, []);

  // Outbound message bubbles/pills live in state/outboxStore.js — the single
  // owner of the send lifecycle (Composer, Messages and useLive all touch it,
  // and they don't share a subtree below this provider).

  const value = useMemo(() => ({
    composer, updateComposer, toggleGitMode, registerGitModeToggle,
  }), [composer, updateComposer, toggleGitMode, registerGitModeToggle]);

  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

export function useComposer() {
  const c = useContext(ComposerContext);
  if (!c) throw new Error("useComposer outside ComposerProvider");
  return c;
}
