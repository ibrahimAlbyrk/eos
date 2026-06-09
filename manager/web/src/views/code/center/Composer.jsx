import { useEffect, useRef, useState, useMemo } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { startRun } from "../../../state/terminalStore.js";
import { useCommands } from "../../../hooks/useCommands.js";
import { useTemplates } from "../../../hooks/useTemplates.js";
import { useContentEditableEditor, getCursorOffset, getSelectionOffsets, setSelectionOffsets } from "../../../hooks/useContentEditableEditor.js";
import { useCompletion } from "../../../hooks/useCompletion.js";
import { findPlaceholders, nextPlaceholder, prevPlaceholder } from "../../../lib/placeholders.js";
import { useAttachments } from "../../../hooks/useAttachments.js";
import { useInputHistory } from "../../../hooks/useInputHistory.js";
import { findLabelAt } from "../../../lib/attachmentTokens.js";
import { menuVisibility, escapeMenu, menuDismissedOnQueryChange } from "../../../lib/completionMenu.js";
import { escChord, ESC_CHORD_WINDOW_MS } from "../../../lib/escapeChord.js";
import { gitAgentName, gitTaskLabel } from "../../../lib/gitAgentName.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";
import { CommandMenu } from "./CommandMenu.jsx";
import { FileMenu } from "./FileMenu.jsx";
import { AttachmentChips } from "./AttachmentChips.jsx";
import { PermissionBanner } from "./PermissionBanner.jsx";
import { QuestionBanner } from "./QuestionBanner.jsx";
import { TryBanner } from "./TryBanner.jsx";

// Native Claude TUI commands the agent executes itself — sent as a plain
// message ("/clear" pasted + CR runs the command); listed for discoverability.
const BUILTIN_COMMANDS = [
  { name: "clear", description: "Clear conversation history (agent context + chat)", source: "builtin" },
];

function QueuedPill({ text, onDismiss }) {
  return (
    <div className="queued-pill">
      <div className="queued-pill-text">{text}</div>
      <button className="queued-pill-x" onClick={onDismiss} title="Cancel queued message">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

export function Composer({ live }) {
  const ui = useUi();
  const [menuIndex, setMenuIndex] = useState(0);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const insertedPathsRef = useRef(new Map());
  const history = useInputHistory();
  const termHistory = useInputHistory("cm:termHistory");
  const lastEscRef = useRef(0);
  const [escArmed, setEscArmed] = useState(false);
  // True while showing a history-recalled entry; keeps the slash/file menus
  // suppressed (the query-change effects below would otherwise re-open them).
  // Cleared on the next real input event.
  const recallRef = useRef(false);

  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;

  // Global Escape exits git/terminal mode regardless of focus — registered into
  // the selection provider's Escape chain (popover/viewers first, interrupt last).
  useEffect(() => {
    ui.registerEscapeGitMode(() => {
      if (ui.composer.termMode) {
        ui.updateComposer({ termMode: false });
        return true;
      }
      if (!ui.composer.gitMode) return false;
      ui.updateComposer({ gitMode: false });
      return true;
    });
    return () => ui.registerEscapeGitMode(null);
  }, [ui.composer.gitMode, ui.composer.termMode, ui.registerEscapeGitMode, ui.updateComposer]);

  const cwd = selected?.cwd ?? ui.composer.cwd ?? live.recents[0] ?? null;
  const commands = useCommands(cwd);
  const cmdMap = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);

  // Templates join the slash menu next to commands (same name allowed — the
  // tooltip's "(template)" / "(skill)" source tag disambiguates).
  const templates = useTemplates();
  const slashItems = useMemo(() => [
    ...BUILTIN_COMMANDS,
    ...commands,
    ...templates.map((t) => ({ name: t.name, description: t.description, source: "template", template: t })),
  ], [commands, templates]);

  const uploadFailedRef = useRef(() => {});
  const {
    items: attachmentItems,
    addUpload,
    addPath,
    remove: removeAttachmentItem,
    clear: clearAttachments,
    resolveForSend,
  } = useAttachments({ onUploadFailed: (label) => uploadFailedRef.current(label) });

  const {
    text,
    cursorPos,
    setCursorPos,
    editorRef,
    setTextAndSync,
    handleInput,
  } = useContentEditableEditor(cmdMap, insertedPathsRef, ui.selectedId, attachmentItems);

  const stripLabel = (label) => {
    const idx = text.indexOf(label);
    if (idx === -1) return;
    let end = idx + label.length;
    if (text[end] === " ") end++;
    setTextAndSync(text.slice(0, idx) + text.slice(end), idx);
  };
  uploadFailedRef.current = stripLabel;

  const insertLabels = (labels, pos) => {
    const chunk = labels.map((l) => l + " ").join("");
    setTextAndSync(text.slice(0, pos) + chunk + text.slice(pos), pos + chunk.length);
  };

  const removeAttachmentToken = (label) => {
    removeAttachmentItem(label);
    stripLabel(label);
  };

  // Token is the source of truth: if its text is gone (select-all delete,
  // double-esc, manual edit), drop the chip too.
  useEffect(() => {
    for (const it of attachmentItems) {
      if (!text.includes(it.label)) removeAttachmentItem(it.label);
    }
  }, [text, attachmentItems, removeAttachmentItem]);

  const { slashCtx, atCtx, filtered, atResults, activeMenu } = useCompletion({
    text,
    cursorPos,
    commands: slashItems,
    cwd,
    selected,
    workers: live.workers,
    insertedPathsRef,
  });

  const menuVis = menuVisibility({ activeMenu, menuDismissed });
  // Terminal mode: shell text is full of `/` and `@` — completion menus off.
  const showMenu = menuVis.showMenu && !ui.composer.termMode;
  const showFileMenu = menuVis.showFileMenu && !ui.composer.termMode;
  const activeHistory = ui.composer.termMode ? termHistory : history;

  const activeHint = useMemo(() => {
    if (!text.includes("/")) return null;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "/") continue;
      let end = i + 1;
      while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
      const cmd = cmdMap.get(text.slice(i + 1, end));
      if (!cmd?.argumentHint) continue;
      const after = text.slice(end);
      if (after === " ") return cmd.argumentHint;
    }
    return null;
  }, [text, cmdMap]);

  // Template queued by the picker popover or the ⌘K palette — replaces the
  // whole input, then enters placeholder navigation.
  useEffect(() => {
    const pt = ui.composer.pendingTemplate;
    if (!pt) return;
    ui.updateComposer({ pendingTemplate: null });
    insertedPathsRef.current.clear();
    applyTemplateText(pt.content, 0);
  }, [ui.composer.pendingTemplate]);

  // Restored prompt queued by the rewind panel — replaces the input so the
  // user can edit and resend, mirroring Claude Code's native rewind.
  useEffect(() => {
    const pt = ui.composer.pendingText;
    if (!pt) return;
    ui.updateComposer({ pendingText: null });
    insertedPathsRef.current.clear();
    setTextAndSync(pt.content, pt.content.length);
    editorRef.current?.focus();
  }, [ui.composer.pendingText]);

  useEffect(() => { setMenuIndex(0); setMenuDismissed(recallRef.current || menuDismissedOnQueryChange()); }, [slashCtx?.query]);
  useEffect(() => { setFileMenuIndex(0); setMenuDismissed(recallRef.current || menuDismissedOnQueryChange()); }, [atCtx?.query]);

  useEffect(() => { setEscArmed(false); }, [text]);
  useEffect(() => {
    if (!escArmed) return;
    const t = setTimeout(() => setEscArmed(false), ESC_CHORD_WINDOW_MS);
    return () => clearTimeout(t);
  }, [escArmed]);

  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

  const handlePaste = (e) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : text.length;
      const labels = files.map((file) => {
        const ext = file.name?.split(".").pop()?.toLowerCase() ?? "";
        const kind = IMAGE_EXTS.has(ext) || file.type.startsWith("image/") ? "image" : "file";
        return addUpload(kind, file);
      });
      insertLabels(labels, pos);
      return;
    }
    e.preventDefault();
    const plain = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, plain);
  };

  const addAttachments = (atts) => {
    const labels = atts.map((a) => addPath(a.type, a.path));
    insertLabels(labels, cursorPos);
    editorRef.current?.focus();
  };

  const findCommandAt = (pos) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "/") continue;
      let end = i + 1;
      while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
      if (cmdMap.has(text.slice(i + 1, end)) && pos > i && pos <= end) {
        return { start: i, end };
      }
    }
    return null;
  };

  // Insert template content, select the first {{placeholder}} so typing
  // replaces it; Tab/Shift+Tab walk the rest (see onKey).
  const applyTemplateText = (newText, searchFrom) => {
    const ph = nextPlaceholder(findPlaceholders(newText), searchFrom);
    setTextAndSync(newText, ph ? ph.start : newText.length);
    const el = editorRef.current;
    el?.focus();
    if (ph && el) {
      setSelectionOffsets(el, ph.start, ph.end);
      setCursorPos(ph.start);
    }
  };

  const selectCommand = (cmd) => {
    if (cmd.template) {
      const start = slashCtx ? slashCtx.start : 0;
      const end = slashCtx ? cursorPos : text.length;
      const before = text.slice(0, start);
      const newText = before + cmd.template.content + text.slice(end);
      setMenuIndex(0);
      applyTemplateText(newText, before.length);
      return;
    }
    if (slashCtx) {
      const before = text.slice(0, slashCtx.start);
      const after = text.slice(cursorPos);
      const inserted = `/${cmd.name} `;
      const newText = before + inserted + after;
      const newPos = before.length + inserted.length;
      setTextAndSync(newText, newPos);
    } else {
      setTextAndSync(`/${cmd.name} `);
    }
    setMenuIndex(0);
    editorRef.current?.focus();
  };

  const selectFile = (entry) => {
    if (!atCtx) return;
    const before = text.slice(0, atCtx.start);
    const after = text.slice(cursorPos);
    const newDisplay = entry.type === "agent" ? entry.name : entry.relativePath;
    for (const [existing] of insertedPathsRef.current) {
      if (newDisplay.startsWith(existing + "/") || existing.startsWith(newDisplay + "/") || existing === newDisplay) {
        insertedPathsRef.current.delete(existing);
      }
    }
    if (entry.type === "agent") {
      const inserted = "@" + entry.name + " ";
      const newText = before + inserted + after;
      insertedPathsRef.current.set(entry.name, "@" + entry.name);
      setTextAndSync(newText, before.length + inserted.length);
    } else {
      const inserted = "@" + entry.relativePath + " ";
      const newText = before + inserted + after;
      insertedPathsRef.current.set(entry.relativePath, entry.absolutePath);
      setTextAndSync(newText, before.length + inserted.length);
    }
    setFileMenuIndex(0);
    editorRef.current?.focus();
  };

  const findPathAt = (pos) => {
    for (const [display] of insertedPathsRef.current) {
      const token = "@" + display;
      const idx = text.indexOf(token);
      if (idx !== -1 && pos > idx && pos <= idx + token.length) {
        return { start: idx, end: idx + token.length, display };
      }
    }
    return null;
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;

    if (ui.composer.termMode) {
      termHistory.push(t);
      setTextAndSync("", 0);
      // One-shot like git mode: the mode closes on send, `!` re-enters.
      ui.updateComposer({ termMode: false });
      if (selected) {
        const r = await api.runTerminal(selected.id, t);
        if (r?.ok && r.body?.runId) startRun(selected.id, r.body.runId, t);
        return;
      }
      // No agent selected → workspace-scoped run in the composer's cwd;
      // ephemeral cards in the empty center, gone once an agent is selected.
      const wsCwd = ui.composer.cwd ?? live.recents[0] ?? null;
      if (!wsCwd) { alert("Pick a folder first."); return; }
      const r = await api.runWorkspaceTerminal(wsCwd, t);
      if (r?.ok && r.body?.runId) startRun(null, r.body.runId, t);
      return;
    }

    // "/clear" targets an existing agent's session — spawning a fresh agent
    // (orchestrator/git) with it as the boot prompt would be meaningless.
    if (t === "/clear" && (!selected || ui.composer.gitMode)) return;

    let displayText = t;
    let agentText = t;
    for (const [display, absPath] of insertedPathsRef.current) {
      agentText = agentText.replaceAll("@" + display, absPath);
    }

    const msgLabels = attachmentItems.map((it) => it.label);
    history.push(t);
    setTextAndSync("", 0);
    insertedPathsRef.current.clear();
    clearAttachments();

    const suffix = await resolveForSend(msgLabels);
    displayText += suffix;
    agentText += suffix;

    if (ui.composer.gitMode) {
      // A worktree worker is selected → the git task is about ITS tree, so
      // the git agent attaches INSIDE that worktree (direct file access, no
      // `git -C` indirection); its Environment section carries the branch and
      // checkout facts. Integration into the user's branch stays a checkout
      // task (the popover's Integrate action).
      if (selected?.worktree_dir && selected?.branch) {
        ui.updateComposer({ gitMode: false });
        const r = await live.spawnGitAgent({
          workspaceOf: selected.id,
          prompt: agentText,
          name: gitAgentName(selected.worktree_from, selected.branch, gitTaskLabel(t)),
        });
        if (r?.ok && r.body?.id) {
          ui.setSelectedId(r.body.id);
          ui.addOptimisticUserMessage(r.body.id, displayText, agentText);
        } else if (!r?.ok) {
          alert(r?.body?.error ?? "git agent spawn failed");
        }
        return;
      }
      // Otherwise the git agent runs in the user's checkout — told which
      // branch matters, since its cwd's current branch is the user's, not
      // the worker's.
      const gitCwd = selected
        ? (selected.cwd ?? selected.worktree_from)
        : (ui.composer.cwd ?? live.recents[0] ?? null);
      if (!gitCwd) { alert("Pick a folder first."); return; }
      ui.updateComposer({ gitMode: false });
      const gitBranch = selected?.branch ?? ui.composer.branch ?? null;
      if (selected?.branch && selected?.worktree_from) {
        agentText = `Context: the selected Eos worker's branch is ${selected.branch} (a live agent worktree — never check it out or delete it).\n\n${agentText}`;
      }
      const r = await live.spawnGitAgent({
        cwd: gitCwd,
        prompt: agentText,
        name: gitAgentName(gitCwd, gitBranch, gitTaskLabel(t)),
      });
      if (r?.ok && r.body?.id) {
        ui.setSelectedId(r.body.id);
        ui.addOptimisticUserMessage(r.body.id, displayText, agentText);
      }
      return;
    }

    if (selected) {
      const busy = selected.state === "SPAWNING" || selected.state === "WORKING";
      if (busy) {
        ui.addQueuedMessage(selected.id, agentText);
        return;
      }
      ui.addOptimisticUserMessage(selected.id, displayText, agentText);
      try { await live.sendToAgent(selected.id, agentText); }
      catch (e) { console.error("send failed:", e); }
      return;
    }

    const cwdFallback = ui.composer.cwd ?? live.recents[0] ?? null;
    if (!cwdFallback) { alert("Pick a folder first."); return; }
    const r = await live.spawnOrchestrator({ cwd: cwdFallback, model: ui.composer.model, effort: ui.composer.effort, prompt: agentText, permissionMode: ui.composer.permissionMode });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      ui.addOptimisticUserMessage(realId, displayText, agentText);
    }
  };

  const applyEscapeMenu = () => {
    const { keepText, dismissed } = escapeMenu();
    if (!keepText) setTextAndSync("", 0);
    setMenuDismissed(dismissed);
  };

  const onKey = (e) => {
    if (showMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[menuIndex]) selectCommand(filtered[menuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        applyEscapeMenu();
        return;
      }
    }

    if (showFileMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMenuIndex((i) => (i + 1) % atResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMenuIndex((i) => (i - 1 + atResults.length) % atResults.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (atResults[fileMenuIndex]) selectFile(atResults[fileMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        applyEscapeMenu();
        return;
      }
    }

    // `!` as the first char of an empty input enters terminal mode (the char
    // is consumed) — mirrors the Claude Code TUI bash-mode affordance.
    // With no agent selected the run is workspace-scoped — any cwd candidate
    // (composer picker / recents) is enough to enter the mode.
    if (e.key === "!" && !text && !ui.composer.termMode && !ui.composer.gitMode && (selected || cwd)) {
      e.preventDefault();
      ui.updateComposer({ termMode: true });
      return;
    }

    if (e.key === "Tab") {
      const phs = findPlaceholders(text);
      if (phs.length > 0) {
        e.preventDefault();
        const el = editorRef.current;
        if (!el) return;
        const sel = getSelectionOffsets(el);
        const ph = e.shiftKey ? prevPlaceholder(phs, sel.start) : nextPlaceholder(phs, sel.end);
        if (ph) {
          setSelectionOffsets(el, ph.start, ph.end);
          setCursorPos(ph.start);
        }
        return;
      }
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const recalled = e.key === "ArrowUp" ? activeHistory.up(text) : activeHistory.down(text);
      if (recalled !== null) {
        e.preventDefault();
        recallRef.current = true;
        setTextAndSync(recalled);
        return;
      }
    }

    if (e.key === "Escape") {
      const { isDouble, ts } = escChord(lastEscRef.current, Date.now());
      lastEscRef.current = ts;
      if (isDouble && text !== "") {
        e.preventDefault();
        e.stopPropagation();
        setTextAndSync("", 0);
        insertedPathsRef.current.clear();
      } else if (text !== "") {
        setEscArmed(true);
      }
      // first Esc: not consumed — bubbles to the global handler (interrupt etc.)
      return;
    }

    if (e.key === "Backspace") {
      if (ui.composer.termMode && !text) {
        e.preventDefault();
        ui.updateComposer({ termMode: false });
        return;
      }
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : 0;
      const attHit = findLabelAt(text, pos, attachmentItems.map((it) => it.label));
      if (attHit) {
        e.preventDefault();
        const next = text.slice(0, attHit.start) + text.slice(attHit.end);
        setTextAndSync(next, attHit.start);
        return;
      }
      const pathHit = findPathAt(pos);
      if (pathHit) {
        e.preventDefault();
        insertedPathsRef.current.delete(pathHit.display);
        const next = text.slice(0, pathHit.start) + text.slice(pathHit.end);
        setTextAndSync(next, pathHit.start);
        return;
      }
      const cmd = findCommandAt(pos);
      if (cmd) {
        e.preventDefault();
        const next = text.slice(0, cmd.start) + text.slice(cmd.end);
        setTextAndSync(next, cmd.start);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const agentBusy = selected && (selected.state === "SPAWNING" || selected.state === "WORKING");
  const queuedList = selected ? (ui.queuedMessages.get(selected.id) ?? []) : [];

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {queuedList.length > 0 && (
          <div className="queued-list">
            {queuedList.map((q) => (
              <QueuedPill
                key={q.id}
                text={q.text}
                onDismiss={() => ui.removeQueuedMessage(selected.id, q.id)}
              />
            ))}
          </div>
        )}
        {ui.pendingQuestion && selected && !ui.dismissedQuestions?.has(ui.pendingQuestion.toolUseId) && (
          <QuestionBanner
            questions={ui.pendingQuestion.questions}
            workerId={selected.id}
            toolUseId={ui.pendingQuestion.toolUseId}
            onClose={() => ui.dismissQuestion(ui.pendingQuestion.toolUseId)}
          />
        )}
        <PermissionBanner
          permissions={(live.pendingPermissions ?? []).filter(
            (p) => !selected || p.worker_id === selected.id
          )}
          workers={live.workers}
          onApprove={live.approvePending}
          onAlwaysAllow={live.alwaysAllowPending}
          onDeny={live.denyPending}
        />
        <TryBanner live={live} selected={selected} />
        {selected ? (
          <ComposerDiffRow live={live} />
        ) : (
          <ComposerConfigRow live={live} />
        )}

        <div className="c-row2-wrap">
          {showMenu && (
            <CommandMenu
              commands={filtered}
              selectedIndex={menuIndex}
              onSelect={selectCommand}
              query={slashCtx?.query ?? ""}
            />
          )}
          {showFileMenu && (
            <FileMenu
              entries={atResults}
              selectedIndex={fileMenuIndex}
              onSelect={selectFile}
              query={atCtx?.query ?? ""}
            />
          )}
          <div className={ui.composer.termMode ? "c-row2 term-mode" : ui.composer.gitMode ? "c-row2 git-mode" : "c-row2"}>
            {attachmentItems.length > 0 && (
              <AttachmentChips attachments={attachmentItems} onRemove={removeAttachmentToken} />
            )}
            {ui.composer.termMode && <span className="term-prompt" aria-hidden>❯</span>}
            <div
              ref={editorRef}
              className={escArmed ? "composer-editor esc-armed" : "composer-editor"}
              contentEditable
              role="textbox"
              data-placeholder={ui.composer.termMode ? "Run a shell command — Enter to run, Esc to exit" : ui.composer.gitMode ? "Describe the git task — commit, rebase, merge…" : "Type / for commands, @ for files"}
              data-empty={!text ? "" : undefined}
              data-hint={activeHint || undefined}
              onInput={(e) => { recallRef.current = false; handleInput(e); }}
              onKeyDown={onKey}
              onPaste={handlePaste}
              onClick={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
              onKeyUp={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
            />
            <button className="submit" title="Send" onClick={send}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v5H4m3-3l-3 3 3 3" />
              </svg>
            </button>
          </div>
        </div>

        <ComposerControls
          live={live}
          onAttach={addAttachments}
          historyNav={activeHistory.nav && text === activeHistory.nav.entry ? activeHistory.nav : null}
        />
      </div>
    </div>
  );
}
