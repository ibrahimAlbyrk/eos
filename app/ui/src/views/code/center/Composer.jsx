import { useEffect, useRef, useState, useMemo } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { startRun } from "../../../state/terminalStore.js";
import * as outbox from "../../../state/outboxStore.js";
import { useCommands } from "../../../hooks/useCommands.js";
import { useSlashItems } from "../../../hooks/useSlashItems.js";
import { useContentEditableEditor, getCursorOffset, getSelectionOffsets, setSelectionOffsets, scrollSelectionIntoView } from "../../../hooks/useContentEditableEditor.js";
import { listContinuation, listIndent } from "../../../lib/markdownBlocks.js";
import { useCompletion } from "../../../hooks/useCompletion.js";
import { findPlaceholders, nextPlaceholder, prevPlaceholder } from "../../../lib/placeholders.js";
import { useAttachments } from "../../../hooks/useAttachments.js";
import { useComposerDraftSync } from "../../../hooks/useComposerDraftSync.js";
import { useInputHistory } from "../../../hooks/useInputHistory.js";
import { draftKey } from "../../../state/composerDrafts.js";
import { findLabelAt, parseAttachmentMessage } from "../../../lib/attachmentTokens.js";
import { menuVisibility, escapeMenu, menuDismissedOnQueryChange } from "../../../lib/completionMenu.js";
import { escChord, ESC_CHORD_WINDOW_MS } from "../../../lib/escapeChord.js";
import { composerMode, modeFlags } from "../../../lib/composerModes.js";
import { attachmentKind } from "../../../lib/attachmentKind.js";
import { hasPasteboardBridge, readPasteboardPaths, onNativeDrop, onDragState } from "../../../lib/nativeBridge.js";
import { gitAgentName, gitTaskLabel } from "../../../lib/gitAgentName.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";
import { CommandMenu } from "./CommandMenu.jsx";
import { FileMenu } from "./FileMenu.jsx";
import { AttachmentChips } from "./AttachmentChips.jsx";
import { PermissionBanner } from "./PermissionBanner.jsx";
import { UpdateBanner } from "./UpdateBanner.jsx";
import { SlashInfoPopover } from "../popovers/SlashInfoPopover.jsx";
import { QuestionBanner } from "./QuestionBanner.jsx";
import { TryDeck } from "./TryBanner.jsx";
import { TaskTray } from "./TaskTray.jsx";

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

// Bounded backlog box: past the CSS max-height the pills scroll; the gradient
// masks soften an edge only when more pills continue past it, and an enqueue
// keeps the newest pill (bottom — next in dispatch order is the top) in view.
function QueuedList({ items, onDismiss }) {
  const ref = useRef(null);

  const syncFades = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle("qfade-top", el.scrollTop > 2);
    el.classList.toggle("qfade-bot", el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // smooth via CSS scroll-behavior
    syncFades();
  }, [items.length]);

  return (
    <div className="queued-list" ref={ref} onScroll={syncFades}>
      {items.map((q) => (
        <QueuedPill key={q.id} text={q.text} onDismiss={() => onDismiss(q.id)} />
      ))}
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
  const lastEscRef = useRef(0);
  const [escArmed, setEscArmed] = useState(false);
  // True while showing a history-recalled entry; keeps the slash/file menus
  // suppressed (the query-change effects below would otherwise re-open them).
  // Cleared on the next real input event.
  const recallRef = useRef(false);

  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;

  // Pills render from the outbox (state/outboxStore.js — the single owner of
  // the send lifecycle), which mirrors the daemon queue. Synced on selection
  // change and on the agent's SSE signal; the store dedupes in-flight fetches.
  const [, setOutboxTick] = useState(0);
  useEffect(() => outbox.subscribe(() => setOutboxTick((t) => t + 1)), []);
  useEffect(() => { if (selected?.id) outbox.syncQueue(selected.id); }, [selected?.id]);
  useEffect(() => {
    if (!selected?.id || live.eventSignal.workerId !== selected.id) return;
    outbox.syncQueue(selected.id);
  }, [live.eventSignal.tick]);

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

  const slashItems = useSlashItems(cwd);
  // Pill highlighting + click-info lookup span the full slash universe
  // (builtins/templates included), unlike cmdMap (daemon commands only,
  // drives argument hints and token deletion).
  const slashMap = useMemo(() => new Map(slashItems.map((c) => [c.name, c])), [slashItems]);

  const uploadFailedRef = useRef(() => {});
  const {
    items: attachmentItems,
    addUpload,
    addPath,
    addResolved,
    remove: removeAttachmentItem,
    clear: clearAttachments,
    restore: restoreAttachments,
    reconcileToText,
    resolveForSend,
  } = useAttachments({ onUploadFailed: (label) => uploadFailedRef.current(label) });

  const {
    text,
    cursorPos,
    setCursorPos,
    editorRef,
    setTextAndSync,
    handleInput,
    undo,
    redo,
  } = useContentEditableEditor(slashMap, insertedPathsRef, ui.selectedId, attachmentItems, reconcileToText);

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

  // Stash this agent's unsent input on switch, re-seat the next agent's.
  // Text, chips and @paths swap in one effect body (one React batch) so the
  // token-GC effects never see one agent's text against another's chips.
  // git/term modes ride along: a term-mode draft restored without the mode
  // would send as a chat message instead of running as a shell command.
  useComposerDraftSync(
    draftKey(ui.selectedId),
    () => ({
      text,
      cursorPos,
      insertedPaths: [...insertedPathsRef.current],
      attachments: attachmentItems,
      gitMode: ui.composer.gitMode,
      termMode: ui.composer.termMode,
    }),
    (d) => {
      insertedPathsRef.current = new Map(d?.insertedPaths ?? []);
      restoreAttachments(d?.attachments ?? []);
      recallRef.current = true; // suppress menu auto-open, same as history recall
      setTextAndSync(d?.text ?? "", d?.cursorPos ?? 0, "reset"); // new agent = fresh undo baseline
      const gitMode = d?.gitMode ?? false;
      const termMode = d?.termMode ?? false;
      if (ui.composer.gitMode !== gitMode || ui.composer.termMode !== termMode) {
        ui.updateComposer({ gitMode, termMode });
      }
    }
  );

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

  const uploadFiles = (files, pos) => {
    // A Finder folder surfaces as a typeless empty File — uploading it fails
    // and flashes the chip, so drop those entries silently.
    const real = files.filter((f) => f.type || f.size);
    if (!real.length) return;
    const labels = real.map((file) => {
      const kind = file.type.startsWith("image/") ? "image" : attachmentKind(file.name);
      return addUpload(kind, file);
    });
    insertLabels(labels, pos);
  };

  const handlePaste = (e) => {
    const plain = e.clipboardData.getData("text/plain");
    // A copied Eos message carries the machine-readable "attachments:" suffix as
    // plain text. Reconstruct chips + inline tokens from it instead of pasting
    // the suffix literally — and do it BEFORE the file branch so a native ⌘C
    // that also put the image on the clipboard re-seats by path (no re-upload).
    const parsed = parseAttachmentMessage(plain);
    if (parsed.attachments.length) {
      e.preventDefault();
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : text.length;
      let display = parsed.display;
      for (const att of parsed.attachments) {
        if (!att.label || !att.path) continue;
        const remap = addResolved(att);
        if (remap) display = display.replaceAll(remap.from, remap.to);
      }
      setTextAndSync(text.slice(0, pos) + display + text.slice(pos), pos + display.length);
      return;
    }

    const files = Array.from(e.clipboardData.files);
    const hasFiles = files.length > 0 || e.clipboardData.types.includes("Files");
    if (hasFiles) {
      e.preventDefault();
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : text.length;
      if (hasPasteboardBridge()) {
        // Finder copy → reference the on-disk paths (folders included); raw
        // clipboard data (screenshots) has no path → fall back to upload.
        readPasteboardPaths().then((entries) => {
          if (entries?.length) {
            const labels = entries.map((en) => addPath(attachmentKind(en.path, en.isDir), en.path));
            insertLabels(labels, pos);
          } else {
            uploadFiles(files, pos);
          }
        });
        return;
      }
      uploadFiles(files, pos);
      return;
    }
    e.preventDefault();
    document.execCommand("insertText", false, plain);
  };

  const addAttachments = (atts) => {
    const labels = atts.map((a) => addPath(a.type, a.path));
    insertLabels(labels, cursorPos);
    editorRef.current?.focus();
  };

  // Finder drags intercepted by the native layer (EosWebView) — paths arrive
  // via the bridge globals; subscribe once, latest handler through a ref.
  const [dropActive, setDropActive] = useState(false);
  const nativeDropRef = useRef(() => {});
  nativeDropRef.current = (entries) => {
    if (!entries?.length) return;
    addAttachments(entries.map((en) => ({ type: attachmentKind(en.path, en.isDir), path: en.path })));
  };
  useEffect(() => {
    const offDrop = onNativeDrop((entries) => nativeDropRef.current(entries));
    const offDrag = onDragState(setDropActive);
    return () => { offDrop(); offDrag(); };
  }, []);

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

  // Select a {{placeholder}}, keep cursorPos in sync, and reveal it when the
  // input has scrolled past the visible window (Selection changes don't auto-scroll).
  const selectPlaceholder = (el, ph) => {
    setSelectionOffsets(el, ph.start, ph.end);
    scrollSelectionIntoView(el);
    setCursorPos(ph.start);
  };

  // Insert template content, select the first {{placeholder}} so typing
  // replaces it; Tab/Shift+Tab walk the rest (see onKey).
  const applyTemplateText = (newText, searchFrom) => {
    const ph = nextPlaceholder(findPlaceholders(newText), searchFrom);
    setTextAndSync(newText, ph ? ph.start : newText.length);
    const el = editorRef.current;
    el?.focus();
    if (ph && el) selectPlaceholder(el, ph);
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

  // Shared text-prep for a normal (non-term) send: resolve @paths + pending
  // attachments, clear the input, return display/agent text. Single-send and
  // broadcast both use it so they stay identical.
  const prepareMessage = async () => {
    const t = text.trim();
    let agentText = t;
    for (const [display, absPath] of insertedPathsRef.current) {
      agentText = agentText.replaceAll("@" + display, absPath);
    }
    const msgLabels = attachmentItems.map((it) => it.label);
    setTextAndSync("", 0, "reset"); // sent → undo must not reach back into it
    insertedPathsRef.current.clear();
    clearAttachments();
    const suffix = await resolveForSend(msgLabels);
    return { displayText: t + suffix, agentText: agentText + suffix };
  };

  // Optimistic send of one prepared message to one agent. The daemon decides
  // queue-vs-dispatch; settleSend reconciles the optimistic bubble/pill.
  const dispatchTo = async (worker, displayText, agentText) => {
    const clientMsgId = crypto.randomUUID();
    const busy = worker.state === "WORKING";
    const itemId = outbox.beginSend(worker.id, { text: displayText, agentText, clientMsgId, busy });
    try {
      const r = await live.sendToAgent(worker.id, agentText, { clientMsgId, queueWhenBusy: true });
      outbox.settleSend(worker.id, itemId, r);
      if (!r?.ok && !r?.body?.queued) {
        console.error("send rejected:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
      }
    } catch (e) {
      outbox.settleSend(worker.id, itemId, { ok: false });
      console.error("send failed:", e);
    }
  };

  // Broadcast the current message to every agent shown in a split pane.
  const sendBroadcast = async () => {
    const t = text.trim();
    if (!t || ui.composer.gitMode || ui.composer.termMode) return;
    const ids = [...new Set((ui.paneAgents ?? []).filter(Boolean))];
    const targets = ids.map((id) => live.workers.find((w) => w.id === id)).filter(Boolean);
    if (targets.length === 0) return;
    history.push({ text: t, mode: composerMode(ui.composer) });
    const { displayText, agentText } = await prepareMessage();
    for (const w of targets) dispatchTo(w, displayText, agentText);
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const mode = composerMode(ui.composer);

    // "/clear" targets an existing agent's session — spawning a fresh agent
    // (orchestrator/git) with it as the boot prompt would be meaningless.
    if (mode !== "term" && t === "/clear" && (!selected || ui.composer.gitMode)) return;

    history.push({ text: t, mode });

    if (ui.composer.termMode) {
      setTextAndSync("", 0, "reset");
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

    let { displayText, agentText } = await prepareMessage();

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
          outbox.addDispatched(r.body.id, { text: displayText, agentText });
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
        outbox.addDispatched(r.body.id, { text: displayText, agentText });
      }
      return;
    }

    if (selected) {
      await dispatchTo(selected, displayText, agentText);
      return;
    }

    const cwdFallback = ui.composer.cwd ?? live.recents[0] ?? null;
    if (!cwdFallback) { alert("Pick a folder first."); return; }
    const r = await live.spawnOrchestrator({ cwd: cwdFallback, model: ui.composer.model, effort: ui.composer.effort, prompt: agentText, permissionMode: ui.composer.permissionMode, backendKind: ui.composer.backendKind });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      outbox.addDispatched(realId, { text: displayText, agentText });
    }
  };

  const applyEscapeMenu = () => {
    const { keepText, dismissed } = escapeMenu();
    if (!keepText) setTextAndSync("", 0);
    setMenuDismissed(dismissed);
  };

  const onKey = (e) => {
    // Cmd+Enter → broadcast to all split panes (normal mode only; an open
    // question banner keeps Cmd+Enter for answering).
    if (e.key === "Enter" && e.metaKey && !e.shiftKey && !ui.pendingQuestion
        && ui.paneCount > 1 && !ui.composer.gitMode && !ui.composer.termMode) {
      e.preventDefault();
      sendBroadcast();
      return;
    }
    // Undo / redo — the contentEditable's native history is wiped by every
    // re-color (innerHTML rebuild), so we drive our own debounced stack.
    if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.key === "y" || e.key === "Y") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      redo();
      return;
    }
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
        if (ph) selectPlaceholder(el, ph);
        return;
      }
      // No placeholders → Tab indents / Shift+Tab outdents a markdown list line.
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : cursorPos;
      const indented = listIndent(text, pos, e.shiftKey);
      if (indented) {
        e.preventDefault();
        setTextAndSync(indented.text, indented.cursorPos);
        return;
      }
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const current = { text, mode: composerMode(ui.composer) };
      const recalled = e.key === "ArrowUp" ? history.up(current) : history.down(current);
      if (recalled !== null) {
        e.preventDefault();
        recallRef.current = true;
        setTextAndSync(recalled.text);
        // Cursor lands at the end, but a programmatic selection doesn't
        // auto-scroll — a long recalled entry would otherwise stay pinned to
        // the top. Cursor is always at the end here, so scroll the box down.
        const el = editorRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        if (current.mode !== recalled.mode) ui.updateComposer(modeFlags(recalled.mode));
        return;
      }
    }

    if (e.key === "Escape") {
      const { isDouble, ts } = escChord(lastEscRef.current, Date.now());
      lastEscRef.current = ts;
      if (isDouble && text !== "") {
        e.preventDefault();
        e.stopPropagation();
        history.push({ text, mode: composerMode(ui.composer) });
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

    // Shift+Enter on a list line continues the list (next marker); off a list
    // line it falls through to the default newline.
    if (e.key === "Enter" && e.shiftKey && !ui.composer.termMode) {
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : cursorPos;
      const cont = listContinuation(text, pos);
      if (cont) {
        e.preventDefault();
        setTextAndSync(cont.text, cont.cursorPos);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Pill info popover annotates the text — any edit dismisses it. [text] only:
  // adding openPopover to the deps would close the popover the moment it opens.
  useEffect(() => {
    if (ui.openPopover === "slashinfo") ui.closeAllPops();
  }, [text]);

  // Pills are innerHTML spans, not React children — delegate clicks and
  // hover-intent (150ms enter delay so a pointer pass doesn't flash the card).
  const pillHoverTimer = useRef(null);
  useEffect(() => () => clearTimeout(pillHoverTimer.current), []);

  const openPillInfo = (pill) => {
    if (!pill.isConnected) return;
    const cmd = slashMap.get(pill.dataset.cmd);
    const wrap = pill.closest(".c-row2-wrap");
    if (!cmd || !wrap) return;
    const x = pill.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
    ui.openPop("slashinfo", { x: Math.max(0, Math.min(x, wrap.clientWidth - 300)), y: 0, data: { cmd } });
  };

  const pillAt = (e) => {
    const pill = e.target.closest?.("[data-cmd]");
    return pill && editorRef.current?.contains(pill) ? pill : null;
  };

  const onEditorClick = (e) => {
    const el = editorRef.current;
    if (el) setCursorPos(getCursorOffset(el));
    const pill = pillAt(e);
    if (pill) openPillInfo(pill);
  };

  const onEditorPointerOver = (e) => {
    const pill = pillAt(e);
    if (!pill) return;
    clearTimeout(pillHoverTimer.current);
    pillHoverTimer.current = setTimeout(() => openPillInfo(pill), 150);
  };

  const onEditorPointerOut = (e) => {
    if (!pillAt(e)) return;
    clearTimeout(pillHoverTimer.current);
    if (ui.openPopover === "slashinfo") ui.closeAllPops();
  };

  const agentBusy = selected && (selected.state === "SPAWNING" || selected.state === "WORKING");
  const queuedList = selected ? outbox.itemsFor(selected.id).filter((i) => i.state === "queued") : [];

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <UpdateBanner update={live.update} onApply={live.applyUpdate} onDefer={live.deferUpdate} />
        {queuedList.length > 0 && (
          <QueuedList
            items={queuedList}
            onDismiss={(itemId) => outbox.dismissPill(selected.id, itemId)}
          />
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
        <div className="integration-wrap">
          <TaskTray selected={selected} />
          <TryDeck live={live} selected={selected} />
          {selected ? (
            <ComposerDiffRow live={live} />
          ) : (
            <ComposerConfigRow live={live} />
          )}
        </div>

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
          <SlashInfoPopover />
          <div className={[
            "c-row2",
            ui.composer.termMode ? "term-mode" : ui.composer.gitMode ? "git-mode" : "",
            dropActive ? "drop-active" : "",
          ].filter(Boolean).join(" ")}>
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
              onClick={onEditorClick}
              onPointerOver={onEditorPointerOver}
              onPointerOut={onEditorPointerOut}
              onKeyUp={() => { const el = editorRef.current; if (el) setCursorPos(getCursorOffset(el)); }}
            />
            {ui.paneCount > 1 && !ui.composer.gitMode && !ui.composer.termMode && (
              <button className="submit broadcast-btn" title={`Send to all ${ui.paneCount} panes`} onClick={sendBroadcast}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
                  <path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" />
                </svg>
              </button>
            )}
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
          historyNav={history.nav && text === history.nav.entry.text ? history.nav : null}
        />
      </div>
    </div>
  );
}
