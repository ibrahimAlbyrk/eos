import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { startRun } from "../../../state/terminalStore.js";
import * as outbox from "../../../state/outboxStore.js";
import { notify } from "../../../lib/notify.js";
import { subscribe as subscribeScheduled, itemsFor as scheduledItemsFor, refreshScheduled } from "../../../state/scheduledStore.js";
import { relativeUntil } from "../../../lib/scheduleTime.js";
import { useCommands } from "../../../hooks/useCommands.js";
import { useSlashItems } from "../../../hooks/useSlashItems.js";
import { getRecall, subscribe as subscribeRecall, consumeRecall } from "../../../state/recallStore.js";
import { useContentEditableEditor, getCursorOffset, getFocusOffset, getSelectionOffsets, setSelectionOffsets, extendSelectionToOffset, scrollSelectionIntoView } from "../../../hooks/useContentEditableEditor.js";
import { listContinuation, listIndent } from "../../../lib/markdownBlocks.js";
import { useCompletion } from "../../../hooks/useCompletion.js";
import { findPlaceholders, nextPlaceholder, prevPlaceholder } from "../../../lib/placeholders.js";
import { useAttachments } from "../../../hooks/useAttachments.js";
import { useAttachmentIntake } from "../../../hooks/useAttachmentIntake.js";
import { useComposerDraftSync } from "../../../hooks/useComposerDraftSync.js";
import { useInputHistory } from "../../../hooks/useInputHistory.js";
import { draftKey } from "../../../state/composerDrafts.js";
import { findLabelAt } from "../../../lib/attachmentTokens.js";
import { tokenRegions, tokenAt, atomicCaretTarget } from "../../../lib/composerTokens.js";
import { shouldCollapsePaste, makePasteLabel, pasteLineCount, pastePreview } from "../../../lib/pasteTokens.js";
import { menuVisibility, escapeMenu, menuDismissedOnQueryChange } from "../../../lib/completionMenu.js";
import { parentScope } from "../../../lib/mentionQuery.js";
import { providerSpawn } from "../../../lib/backendCaps.js";
import { escChord, ESC_CHORD_WINDOW_MS } from "../../../lib/escapeChord.js";
import { composerMode, modeFlags, nextGitMode } from "../../../lib/composerModes.js";
import { shouldApplyPendingText } from "../../../lib/composerRestore.js";
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
import { PasteInfoPopover } from "../popovers/PasteInfoPopover.jsx";
import { QuestionBanner } from "./QuestionBanner.jsx";
import { TryDeck } from "./TryBanner.jsx";
import { TaskTray } from "./TaskTray.jsx";
import { WorktreeHub } from "./WorktreeHub.jsx";
import { SubmitButton } from "./SubmitButton.jsx";

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

// Amber cousin of QueuedPill: a message deferred to fireAt. Shows a preview, a
// coarse countdown, and a cancel × (removes the still-pending scheduled row).
function ScheduledPill({ text, eta, onCancel }) {
  return (
    <div className="scheduled-pill">
      <span className="scheduled-pill-clock" aria-hidden>⏱</span>
      <div className="scheduled-pill-text">{text}</div>
      <span className="scheduled-pill-eta">{eta}</span>
      <button className="scheduled-pill-x" onClick={onCancel} title="Zamanlanmış mesajı iptal et">
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

export function Composer({ live, worker, paneId, focused }) {
  const ui = useUi();
  const [menuIndex, setMenuIndex] = useState(0);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // git ("custom task") + terminal modes are per-pane: each pane owns its
  // Composer, so they live here, not in the shared ui.composer singleton. Seeded
  // from the per-agent draft on switch (a term-mode draft restored without the
  // mode would send as chat instead of running a shell command).
  const [gitMode, setGitMode] = useState(false);
  const [termMode, setTermMode] = useState(false);
  // Schedule mode: a chosen fireAt (epoch ms) defers the next send instead of
  // dispatching it. Per-pane like git/term; cleared on send and on agent switch.
  const [scheduleAt, setScheduleAt] = useState(null);
  const insertedPathsRef = useRef(new Map());
  // Collapsed long pastes: placeholder → full text. Held out-of-band (kept out
  // of the model string and the undo-snapshot bulk) and spliced back in at send,
  // exactly like insertedPathsRef does for @paths. seq drives the "#N" counter.
  const pastesRef = useRef(new Map());
  const pasteSeqRef = useRef(0);
  const history = useInputHistory();
  const lastEscRef = useRef(0);
  const [escArmed, setEscArmed] = useState(false);
  // True while showing a history-recalled entry; keeps the slash/file menus
  // suppressed (the query-change effects below would otherwise re-open them).
  // Cleared on the next real input event.
  const recallRef = useRef(false);

  // This composer targets its own pane's worker (null in the single-pane
  // no-agent spawn state) — not the global selection. For the FOCUSED pane the
  // two coincide (the focused leaf mirrors selectedId); other panes drive their
  // own agent.
  const selected = worker;

  // git↔term are mutually exclusive; entering git while term is active is a
  // no-op (nextGitMode encodes it). Shared by the git button, startCustom and
  // the focus-registered Cmd+G handler below.
  const toggleGitMode = useCallback((on) => {
    setGitMode((g) => nextGitMode({ gitMode: g, termMode }, on));
  }, [termMode]);

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

  // Scheduled prompts mirror the store (useLive refreshes it on SSE deltas); we
  // refetch on selection change so a freshly-focused agent shows its own list.
  // Switching agents also drops any half-set schedule mode (it targets the old
  // agent). live.now drives the pill countdowns.
  const [, setSchedTick] = useState(0);
  useEffect(() => subscribeScheduled(() => setSchedTick((t) => t + 1)), []);
  useEffect(() => {
    setScheduleAt(null);
    if (selected?.id) refreshScheduled(selected.id);
  }, [selected?.id]);

  // Escape exits git/terminal mode — but only the FOCUSED pane's composer owns
  // the selection provider's single Escape ref, so N mounted composers don't
  // clobber it. Re-registered on mode change so the handler reads fresh state.
  useEffect(() => {
    if (!focused) return;
    ui.registerEscapeGitMode(() => {
      if (termMode) { setTermMode(false); return true; }
      if (!gitMode) return false;
      setGitMode(false);
      return true;
    });
    return () => ui.registerEscapeGitMode(null);
  }, [focused, gitMode, termMode, ui.registerEscapeGitMode]);

  // Cmd+G routes through the composer provider to whichever composer is focused;
  // register this one's toggler while it holds focus (same single-ref discipline).
  useEffect(() => {
    if (!focused) return;
    ui.registerGitModeToggle(toggleGitMode);
    return () => ui.registerGitModeToggle(null);
  }, [focused, toggleGitMode, ui.registerGitModeToggle]);

  const cwd = selected?.cwd ?? ui.composer.cwd ?? live.recents[0] ?? null;
  const commands = useCommands(cwd);
  const cmdMap = useMemo(() => new Map(commands.map((c) => [c.name, c])), [commands]);

  const slashItems = useSlashItems(cwd);
  // Pill highlighting + click-info lookup span the full slash universe
  // (builtins/templates included), unlike cmdMap (daemon commands only,
  // drives argument hints and token deletion).
  const slashMap = useMemo(() => new Map(slashItems.map((c) => [c.name, c])), [slashItems]);

  const uploadFailedRef = useRef(() => {});
  const attachments = useAttachments({ onUploadFailed: (label) => uploadFailedRef.current(label) });
  const {
    items: attachmentItems,
    addResolved,
    clear: clearAttachments,
    restore: restoreAttachments,
    reconcileToText,
    resolveForSend,
  } = attachments;

  const {
    text,
    cursorPos,
    setCursorPos,
    editorRef,
    setTextAndSync,
    handleInput,
    undo,
    redo,
  } = useContentEditableEditor(slashMap, insertedPathsRef, selected?.id ?? null, attachmentItems, reconcileToText, pastesRef, focused);

  // Attachment intake (paste/drop/picker → [label] tokens + chips), shared with
  // the template editor. The inline token is the source of truth; this hook owns
  // the chip lifecycle, native-drop arbitration and token-aware Backspace.
  const intake = useAttachmentIntake({
    attachments,
    editor: { text, setTextAndSync, cursorPos, editorRef },
  });
  const { addAttachments, removeAttachmentToken, attachmentBackspace, dropActive } = intake;
  uploadFailedRef.current = intake.stripLabel;

  // Same rule for paste placeholders — a removed pill must not survive in the
  // store (else it would re-expand at send though its text is gone). Ref-only
  // mutation: coloring already excludes a placeholder absent from the text.
  useEffect(() => {
    for (const ph of [...pastesRef.current.keys()]) {
      if (!text.includes(ph)) pastesRef.current.delete(ph);
    }
  }, [text]);

  // Stash this agent's unsent input on switch, re-seat the next agent's.
  // Text, chips and @paths swap in one effect body (one React batch) so the
  // token-GC effects never see one agent's text against another's chips.
  // git/term modes ride along: a term-mode draft restored without the mode
  // would send as a chat message instead of running as a shell command.
  useComposerDraftSync(
    draftKey(selected?.id ?? null),
    () => ({
      text,
      cursorPos,
      insertedPaths: [...insertedPathsRef.current],
      pastes: [...pastesRef.current],
      attachments: attachmentItems,
      gitMode,
      termMode,
    }),
    (d) => {
      insertedPathsRef.current = new Map(d?.insertedPaths ?? []);
      pastesRef.current = new Map(d?.pastes ?? []);
      restoreAttachments(d?.attachments ?? []);
      recallRef.current = true; // suppress menu auto-open, same as history recall
      setTextAndSync(d?.text ?? "", d?.cursorPos ?? 0, "reset"); // new agent = fresh undo baseline
      setGitMode(d?.gitMode ?? false);
      setTermMode(d?.termMode ?? false);
    }
  );

  const { slashCtx, atCtx, atIntent, filtered, atResults, activeMenu } = useCompletion({
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
  const showMenu = menuVis.showMenu && !termMode;
  const showFileMenu = menuVis.showFileMenu && !termMode;

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
  // whole input, then enters placeholder navigation. pendingTemplate/pendingText
  // are singletons aimed at the selected agent = the focused pane, so only the
  // focused composer consumes them (else every pane would clear + apply).
  useEffect(() => {
    if (!focused) return;
    const pt = ui.composer.pendingTemplate;
    if (!pt) return;
    ui.updateComposer({ pendingTemplate: null });
    insertedPathsRef.current.clear();
    // Re-seat the template's reference files as chips (no upload — paths are
    // already durable); the inline [label] tokens ride in pt.content.
    for (const att of pt.attachments ?? []) addResolved(att);
    applyTemplateText(pt.content, 0);
  }, [focused, ui.composer.pendingTemplate]);

  // Restored prompt queued by the rewind panel — replaces the input so the user
  // can edit and resend, mirroring Claude Code's native rewind. pendingText is a
  // singleton aimed at the selected agent = the focused pane, so only the focused
  // composer consumes it.
  useEffect(() => {
    if (!focused) return;
    const pt = ui.composer.pendingText;
    if (!pt) return;
    ui.updateComposer({ pendingText: null });
    if (!shouldApplyPendingText(pt, text)) return;
    insertedPathsRef.current.clear();
    setTextAndSync(pt.content, pt.content.length);
    editorRef.current?.focus();
  }, [focused, ui.composer.pendingText]);

  // Recall (interrupt before the agent responded): the daemon returns the
  // just-sent, unanswered message's text. Consumed EXACTLY ONCE by the composer
  // that OWNS recall.workerId — single identity end-to-end (not the focused/
  // selected pane), so split view routes it to the right pane and a re-render /
  // reselect / SSE reconnect never re-prefills. consumeRecall clears the source
  // the instant it applies; a draft typed after sending is never clobbered.
  const [recallTick, setRecallTick] = useState(0);
  useEffect(() => subscribeRecall(() => setRecallTick((t) => t + 1)), []);
  useEffect(() => {
    const r = getRecall();
    if (!r || r.workerId !== selected?.id) return;
    consumeRecall(r.token);
    if ((text ?? "").trim()) return; // don't clobber a draft typed after sending
    insertedPathsRef.current.clear();
    setTextAndSync(r.content, r.content.length);
    editorRef.current?.focus();
  }, [recallTick, selected?.id]);

  useEffect(() => { setMenuIndex(0); setMenuDismissed(recallRef.current || menuDismissedOnQueryChange()); }, [slashCtx?.query]);
  useEffect(() => { setFileMenuIndex(0); setMenuDismissed(recallRef.current || menuDismissedOnQueryChange()); }, [atCtx?.query]);

  useEffect(() => { setEscArmed(false); }, [text]);
  useEffect(() => {
    if (!escArmed) return;
    const t = setTimeout(() => setEscArmed(false), ESC_CHORD_WINDOW_MS);
    return () => clearTimeout(t);
  }, [escArmed]);

  const handlePaste = (e) => {
    if (intake.handlePaste(e)) return; // attachment-suffix or file paste
    e.preventDefault();
    const plain = e.clipboardData.getData("text/plain");
    // Long paste → collapse to a "[Pasted text #N +M lines]" pill; the full
    // text rides in pastesRef and is spliced back at send. Click/Backspace on
    // the pill expand/delete it. Short pastes insert verbatim as before.
    if (shouldCollapsePaste(plain)) {
      const ph = makePasteLabel(++pasteSeqRef.current, pasteLineCount(plain));
      pastesRef.current.set(ph, plain);
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : text.length;
      setTextAndSync(text.slice(0, pos) + ph + " " + text.slice(pos), pos + ph.length + 1);
      return;
    }
    document.execCommand("insertText", false, plain);
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
      for (const att of cmd.template.attachments ?? []) addResolved(att);
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

  // `@`-mention navigation: the typed @fragment IS the browse state, so descend
  // and ascend just rewrite it and let useCompletion re-list (lib/mentionQuery).
  const rewriteAtFragment = (fragment) => {
    if (!atCtx) return;
    const before = text.slice(0, atCtx.start);
    const after = text.slice(cursorPos);
    const inserted = "@" + fragment;
    setTextAndSync(before + inserted + after, before.length + inserted.length);
    setFileMenuIndex(0);
    editorRef.current?.focus();
  };
  const descendInto = (entry) => rewriteAtFragment(entry.relativePath + "/");
  const jumpToCrumb = (targetDir) => rewriteAtFragment(targetDir ? targetDir + "/" : "");
  const ascendDir = () => {
    if (atIntent?.mode !== "browse") return false;
    const parent = parentScope(atIntent.dir);
    if (parent === null) return false;
    rewriteAtFragment(parent ? parent + "/" : "");
    return true;
  };

  const selectFile = (entry) => {
    if (!atCtx) return;
    if (entry.type === "parent") { ascendDir(); return; }
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

  // Atomic token regions over the live model text — the single source the caret
  // jump and click-select read from. `slashNames` is slashMap (the SAME set the
  // editor colors with), so atomicity tracks exactly what renders blue. Computed
  // per event (cheap, never on a render hot path) so it always sees fresh refs.
  const currentTokenRegions = () => tokenRegions(text, {
    slashNames: slashMap,
    paths: [...insertedPathsRef.current.keys()],
    pasteKeys: [...pastesRef.current.keys()],
    attachmentLabels: attachmentItems.map((it) => it.label),
  });

  // Shared text-prep for a normal (non-term) send: resolve @paths + pending
  // attachments, clear the input, return display/agent text. Single-send and
  // broadcast both use it so they stay identical.
  const prepareMessage = async () => {
    const t = text.trim();
    let agentText = t;
    for (const [display, absPath] of insertedPathsRef.current) {
      agentText = agentText.replaceAll("@" + display, absPath);
    }
    // Expand collapsed pastes for the agent; displayText keeps the pill so the
    // chat bubble stays compact (same split as @paths: short shown, full sent).
    for (const [ph, full] of pastesRef.current) {
      agentText = agentText.replaceAll(ph, full);
    }
    const msgLabels = attachmentItems.map((it) => it.label);
    setTextAndSync("", 0, "reset"); // sent → undo must not reach back into it
    insertedPathsRef.current.clear();
    pastesRef.current.clear();
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
    if (!t || gitMode || termMode) return;
    const ids = [...new Set((ui.paneAgents ?? []).filter(Boolean))];
    const targets = ids.map((id) => live.workers.find((w) => w.id === id)).filter(Boolean);
    if (targets.length === 0) return;
    history.push({ text: t, mode: composerMode({ gitMode, termMode }) });
    const { displayText, agentText } = await prepareMessage();
    for (const w of targets) dispatchTo(w, displayText, agentText);
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const mode = composerMode({ gitMode, termMode });

    // "/clear" targets an existing agent's session — spawning a fresh agent
    // (orchestrator/git) with it as the boot prompt would be meaningless.
    if (mode !== "term" && t === "/clear" && (!selected || gitMode)) return;

    // "/export" triggers a conversation download — never sends to any worker.
    if (mode !== "term" && t === "/export") {
      if (!selected) return;
      setTextAndSync("", 0, "reset");
      const tree = !!selected.is_orchestrator;
      api.exportWorker(selected.id, { tree }).catch((e) => console.error("export failed", e));
      return;
    }

    history.push({ text: t, mode });

    // Schedule mode: defer this message to a selected fireAt instead of sending
    // it now. Gated to a normal message aimed at an existing worker (git/term
    // spawn their own agents, and a deferred prompt needs a live target).
    if (scheduleAt && selected && !gitMode && !termMode) {
      const fireAt = scheduleAt;
      setScheduleAt(null);
      const { agentText } = await prepareMessage();
      const r = await api.createScheduledPrompt({ workerId: selected.id, text: agentText, fireAt });
      if (r?.ok) {
        refreshScheduled(selected.id);
      } else {
        notify.error(r?.body?.error ?? "Mesaj zamanlanamadı.");
      }
      return;
    }

    if (termMode) {
      setTextAndSync("", 0, "reset");
      // One-shot like git mode: the mode closes on send, `!` re-enters.
      setTermMode(false);
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

    if (gitMode) {
      // A worktree worker is selected → the git task is about ITS tree, so
      // the git agent attaches INSIDE that worktree (direct file access, no
      // `git -C` indirection); its Environment section carries the branch and
      // checkout facts. Integration into the user's branch stays a checkout
      // task (the popover's Integrate action).
      if (selected?.worktree_dir && selected?.branch) {
        setGitMode(false);
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
      setGitMode(false);
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
    // Resolve the picked provider to spawn fields: a name backed by an operator
    // profile spawns via backendProfile (carrying its kind/baseUrl/auth/params —
    // e.g. claude-sdk's thinking, deepseek's endpoint); a bare subscription kind
    // via backendKind. The operator-chosen model rides along as an OVERRIDE on a
    // profile lane (its pinned model is the default).
    const { backendKind, backendProfile } = providerSpawn(ui.composer.provider);
    const r = await live.spawnOrchestrator({
      cwd: cwdFallback,
      model: ui.composer.model,
      effort: ui.composer.effort,
      prompt: agentText,
      permissionMode: ui.composer.permissionMode,
      backendKind: backendKind ?? undefined,
      backendProfile: backendProfile ?? undefined,
    });
    if (r?.ok && r.body?.id) {
      try {
        localStorage.setItem("cm:lastLaunched", JSON.stringify({
          provider: ui.composer.provider ?? null,
          model: ui.composer.model ?? null,
        }));
      } catch {}
      const realId = r.body.id;
      ui.setSelectedId(realId);
      outbox.addDispatched(realId, { text: displayText, agentText });
    } else if (!r?.ok) {
      alert(r?.body?.error ?? "Failed to start agent");
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
        && ui.paneCount > 1 && !gitMode && !termMode) {
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
      const entry = atResults[fileMenuIndex];
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
      // Tab / → step INTO a folder (or back up via the `..` row); on a file or
      // agent, Tab still commits. Enter always commits the highlighted entry —
      // a folder is thus picked with Enter, descended into with Tab/→.
      if (e.key === "Tab" || e.key === "ArrowRight") {
        if (entry?.type === "parent") { e.preventDefault(); ascendDir(); return; }
        if (entry?.type === "directory") { e.preventDefault(); descendInto(entry); return; }
        if (e.key === "Tab") { e.preventDefault(); if (entry) selectFile(entry); return; }
        // → on a file/agent: fall through to normal cursor movement.
      } else if (e.key === "ArrowLeft") {
        if (ascendDir()) { e.preventDefault(); return; }
        // at the root / in search: fall through to normal cursor movement.
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (entry) selectFile(entry);
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        applyEscapeMenu();
        return;
      }
    }

    // Atomic caret: a plain Arrow (no completion menu open, no word/line
    // modifier) steps OVER a whole @-path or /-command token in one move instead
    // of char-by-char into it. Shift+Arrow extends the selection across it;
    // Option/Cmd+Arrow keep native word/line nav. Non-collapsed + no Shift falls
    // through to native collapse.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !showMenu && !showFileMenu && !e.altKey && !e.metaKey) {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (el && sel?.rangeCount && (e.shiftKey || sel.isCollapsed)) {
        const pos = e.shiftKey ? getFocusOffset(el) : getCursorOffset(el);
        const target = atomicCaretTarget(currentTokenRegions(), pos, e.key === "ArrowLeft" ? "left" : "right");
        if (target != null) {
          e.preventDefault();
          if (e.shiftKey) extendSelectionToOffset(el, target);
          else setSelectionOffsets(el, target, target);
          setCursorPos(target);
          return;
        }
      }
    }

    // `!` as the first char of an empty input enters terminal mode (the char
    // is consumed) — mirrors the Claude Code TUI bash-mode affordance.
    // With no agent selected the run is workspace-scoped — any cwd candidate
    // (composer picker / recents) is enough to enter the mode.
    if (e.key === "!" && !text && !termMode && !gitMode && (selected || cwd)) {
      e.preventDefault();
      setTermMode(true);
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
      const current = { text, mode: composerMode({ gitMode, termMode }) };
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
        if (current.mode !== recalled.mode) {
          const f = modeFlags(recalled.mode);
          setGitMode(f.gitMode);
          setTermMode(f.termMode);
        }
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
        pastesRef.current.clear();
      } else if (text !== "") {
        setEscArmed(true);
      }
      // first Esc: not consumed — bubbles to the global handler (interrupt etc.)
      return;
    }

    if (e.key === "Backspace") {
      if (termMode && !text) {
        e.preventDefault();
        setTermMode(false);
        return;
      }
      const el = editorRef.current;
      const pos = el ? getCursorOffset(el) : 0;
      if (attachmentBackspace(pos)) { e.preventDefault(); return; }
      const pathHit = findPathAt(pos);
      if (pathHit) {
        e.preventDefault();
        insertedPathsRef.current.delete(pathHit.display);
        const next = text.slice(0, pathHit.start) + text.slice(pathHit.end);
        setTextAndSync(next, pathHit.start);
        return;
      }
      const pasteHit = findLabelAt(text, pos, [...pastesRef.current.keys()]);
      if (pasteHit) {
        e.preventDefault();
        pastesRef.current.delete(text.slice(pasteHit.start, pasteHit.end));
        const next = text.slice(0, pasteHit.start) + text.slice(pasteHit.end);
        setTextAndSync(next, pasteHit.start);
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
    if (e.key === "Enter" && e.shiftKey && !termMode) {
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
    if (ui.openPopover === "slashinfo" || ui.openPopover === "pasteinfo") ui.closeAllPops();
  }, [text]);

  // Pills are innerHTML spans, not React children — delegate clicks and
  // hover-intent (150ms enter delay so a pointer pass doesn't flash the card).
  const pillHoverTimer = useRef(null);
  // Close-delay for the paste preview so the pointer can cross the gap onto the
  // (hoverable) card without it vanishing — the card's mouse-enter cancels it.
  const pasteCloseTimer = useRef(null);
  useEffect(() => () => { clearTimeout(pillHoverTimer.current); clearTimeout(pasteCloseTimer.current); }, []);

  // Worktree-fleet summary reported up by ComposerDiffRow — drives the footer
  // mirror shown while the ambient hub is demoted (railYields).
  const [wtStatus, setWtStatus] = useState(null);

  // Anchor a composer popover above a pill: x = pill offset within .c-row2-wrap.
  const openPopAtPill = (pill, id, data, width) => {
    const wrap = pill.closest(".c-row2-wrap");
    if (!wrap) return;
    const x = pill.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
    ui.openPop(id, { x: Math.max(0, Math.min(x, wrap.clientWidth - width)), y: 0, data });
  };

  const openPillInfo = (pill) => {
    if (!pill.isConnected) return;
    const cmd = slashMap.get(pill.dataset.cmd);
    if (!cmd) return;
    openPopAtPill(pill, "slashinfo", { cmd }, 300);
  };

  const openPasteInfo = (pill) => {
    if (!pill.isConnected) return;
    const full = pastesRef.current.get(pill.dataset.paste);
    if (full == null) return;
    openPopAtPill(pill, "pasteinfo", { preview: pastePreview(full), lines: pasteLineCount(full) }, 360);
  };

  const pillAt = (e) => {
    const pill = e.target.closest?.("[data-cmd]");
    return pill && editorRef.current?.contains(pill) ? pill : null;
  };

  const pastePillAt = (e) => {
    const pill = e.target.closest?.("[data-paste]");
    return pill && editorRef.current?.contains(pill) ? pill : null;
  };

  // The paste preview is hoverable; leaving the pill only ARMS a close that the
  // card's own mouse-enter cancels (so the pointer can cross the gap pill→card).
  const keepPasteInfo = () => clearTimeout(pasteCloseTimer.current);
  const closePasteInfoSoon = () => {
    clearTimeout(pasteCloseTimer.current);
    pasteCloseTimer.current = setTimeout(() => {
      if (ui.openPopover === "pasteinfo") ui.closeAllPops();
    }, 220);
  };

  const onEditorClick = (e) => {
    const el = editorRef.current;
    if (el) {
      const pos = getCursorOffset(el);
      // A click landing inside a token selects the whole token as one unit;
      // boundary clicks (start/end) place a plain caret there.
      const hit = tokenAt(currentTokenRegions(), pos, { interiorOnly: true });
      if (hit) { setSelectionOffsets(el, hit.start, hit.end); setCursorPos(hit.end); }
      else setCursorPos(pos);
    }
    const pill = pillAt(e);
    if (pill) openPillInfo(pill);
  };

  const onEditorPointerOver = (e) => {
    const pPill = pastePillAt(e);
    if (pPill) {
      keepPasteInfo(); // moving card→pill must not let the armed close fire
      clearTimeout(pillHoverTimer.current);
      pillHoverTimer.current = setTimeout(() => openPasteInfo(pPill), 150);
      return;
    }
    const pill = pillAt(e);
    if (!pill) return;
    clearTimeout(pillHoverTimer.current);
    pillHoverTimer.current = setTimeout(() => openPillInfo(pill), 150);
  };

  const onEditorPointerOut = (e) => {
    if (pastePillAt(e)) {
      clearTimeout(pillHoverTimer.current); // cancel a not-yet-shown preview
      closePasteInfoSoon();
      return;
    }
    if (pillAt(e)) {
      clearTimeout(pillHoverTimer.current);
      if (ui.openPopover === "slashinfo") ui.closeAllPops();
    }
  };

  const agentBusy = selected && (selected.state === "SPAWNING" || selected.state === "WORKING");
  // Send turns into a stop (interrupt) control only while the agent is responding
  // and the user hasn't typed a follow-up to queue — term/git modes keep send
  // semantics. Same action as the Esc key.
  const showStop = agentBusy && !text.trim() && !termMode && !gitMode;
  const queuedList = selected ? outbox.itemsFor(selected.id).filter((i) => i.state === "queued") : [];
  // Pending scheduled prompts for this agent, soonest first — rendered as amber
  // pills above the queued list.
  const scheduledList = selected
    ? scheduledItemsFor(selected.id).filter((s) => s.status === "pending").sort((a, b) => a.fireAt - b.fireAt)
    : [];
  const cancelScheduled = async (id) => {
    const r = await api.cancelScheduledPrompt(id);
    if (!r.ok) notify.error(r.status === 404 ? "Mesaj zaten gönderildi ya da iptal edildi." : (r.body?.error ?? "İptal başarısız."));
    if (selected?.id) refreshScheduled(selected.id);
  };

  // Priority slot: exactly one blocking banner holds the band, Permission first
  // (a mid-turn tool gate is more time-sensitive than an ask_user), then a
  // pending question. While either is up, ambient status (tasks + worktrees)
  // yields and mirrors into the footer.
  const slotPermissions = (live.pendingPermissions ?? []).filter(
    (p) => !selected || p.worker_id === selected.id
  );
  const hasPermission = slotPermissions.length > 0;
  // ui.pendingQuestion is a singleton, published ONLY by the focused pane's
  // Messages (isActive gate), so it targets the focused pane's worker — gate the
  // banner on `focused` so a non-focused pane never mirrors another's question.
  const hasQuestion = !!(
    focused && ui.pendingQuestion && selected && !ui.dismissedQuestions?.has(ui.pendingQuestion.toolUseId)
  );
  const blockingActive = hasPermission || hasQuestion;
  // The ambient rail also yields while queued pills are visible (same overlap
  // risk as a blocking banner — the rail floats up from .integration-wrap and
  // would sit over the queued list). The footer mirror stays gated on this
  // wider condition too, so tasks/worktree status is still visible somewhere.
  const railYields = blockingActive || queuedList.length > 0;

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <UpdateBanner update={live.update} onApply={live.applyUpdate} onDefer={live.deferUpdate} />
        {scheduledList.length > 0 && (
          <div className="scheduled-list">
            {scheduledList.map((s) => (
              <ScheduledPill
                key={s.id}
                text={s.text}
                eta={relativeUntil(s.fireAt, live.now)}
                onCancel={() => cancelScheduled(s.id)}
              />
            ))}
          </div>
        )}
        {queuedList.length > 0 && (
          <QueuedList
            items={queuedList}
            onDismiss={(itemId) => outbox.dismissPill(selected.id, itemId)}
          />
        )}
        {hasPermission ? (
          <PermissionBanner
            permissions={slotPermissions}
            workers={live.workers}
            onApprove={live.approvePending}
            onAlwaysAllow={live.alwaysAllowPending}
            onDeny={live.denyPending}
          />
        ) : hasQuestion ? (
          <QuestionBanner
            questions={ui.pendingQuestion.questions}
            workerId={selected.id}
            toolUseId={ui.pendingQuestion.toolUseId}
            onClose={() => ui.dismissQuestion(ui.pendingQuestion.toolUseId)}
          />
        ) : null}
        <div className="integration-wrap">
          {/* Ambient rail: tasks (left) + worktree fleet (right) on one line,
              docked flush above the git bar. Both yield to a blocking banner
              or a visible queued-pill list (railYields). */}
          <div className="ambient-rail">
            <TaskTray selected={selected} blockingActive={railYields} />
            <WorktreeHub live={live} selected={selected} blockingActive={railYields} onStatus={setWtStatus} />
          </div>
          <TryDeck live={live} selected={selected} />
          {selected ? (
            <ComposerDiffRow live={live} worker={selected} wtStatus={wtStatus} />
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
              onDescend={descendInto}
              onCrumb={jumpToCrumb}
              query={atIntent?.filter ?? atCtx?.query ?? ""}
              dir={atIntent?.mode === "browse" ? atIntent.dir : ""}
            />
          )}
          <SlashInfoPopover />
          <PasteInfoPopover onMouseEnter={keepPasteInfo} onMouseLeave={closePasteInfoSoon} />
          <div className={[
            "c-row2",
            termMode ? "term-mode" : gitMode ? "git-mode" : "",
            dropActive ? "drop-active" : "",
          ].filter(Boolean).join(" ")}>
            {attachmentItems.length > 0 && (
              <AttachmentChips attachments={attachmentItems} onRemove={removeAttachmentToken} />
            )}
            {termMode && <span className="term-prompt" aria-hidden>❯</span>}
            <div
              ref={editorRef}
              className={escArmed ? "composer-editor esc-armed" : "composer-editor"}
              contentEditable
              role="textbox"
              data-placeholder={termMode ? "Run a shell command — Enter to run, Esc to exit" : gitMode ? "Describe the git task — commit, rebase, merge…" : "Type / for commands, @ for files"}
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
            {focused && ui.paneCount > 1 && !gitMode && !termMode && (
              <button className="submit broadcast-btn" title={`Send to all ${ui.paneCount} panes`} onClick={sendBroadcast}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
                  <path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" />
                </svg>
              </button>
            )}
            <SubmitButton
              stop={showStop}
              onClick={showStop ? () => live.interruptAgent(selected.id) : send}
            />
          </div>
        </div>

        <ComposerControls
          live={live}
          worker={selected}
          gitMode={gitMode}
          onToggleGitMode={toggleGitMode}
          onAttach={addAttachments}
          historyNav={history.nav && text === history.nav.entry.text ? history.nav : null}
          demoted={railYields}
          wtStatus={wtStatus}
          schedule={{ at: scheduleAt, set: setScheduleAt }}
        />
      </div>
    </div>
  );
}
