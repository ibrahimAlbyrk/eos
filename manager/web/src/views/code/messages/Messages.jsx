// Messages — renders the transcript for the selected agent. Pulls events
// for the selection via /workers/:id/events and maps each event type to a
// renderable block.
//
// This is the initial render layer; refinement (tool-group collapse, file
// chips, table rendering) lives in dedicated sub-components.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { fmtElapsedShort } from "../../../lib/format.js";
import { deriveActivity } from "../../../lib/agentActivity.js";
import { buildBlocks, applyRewinds, applyClears, sortBlocksByTs } from "../../../lib/messageParser.js";
import { normRewindText } from "../../../lib/rewindMatch.js";
import { deriveVerdict, deriveChildVerdicts } from "../../../lib/verdict.js";
import { derivePendingQuestions } from "../../../lib/pendingQuestions.js";
import { loadScrollPos, saveScrollPos, clearScrollPos } from "../../../lib/scrollMemory.js";
import { captureAnchor, resolveAnchorTop } from "../../../lib/scrollAnchor.js";
import { usePageFind } from "../../../hooks/usePageFind.js";
import { useWorkerEvents } from "../../../hooks/useWorkerEvents.js";
import { useStickToBottom } from "../../../hooks/useStickToBottom.js";
import { useRewind } from "../../../hooks/useRewind.js";
import { defaultGroupOpen } from "../../../settings/toolExpansion.js";
import { ScrollHoldContext } from "./scrollHoldContext.js";
import { FindBar } from "./FindBar.jsx";
import { MessageUser } from "./MessageUser.jsx";
import { MessageReport } from "./MessageReport.jsx";
import { MessageAssistant } from "./MessageAssistant.jsx";
import { ToolGroup } from "./ToolGroup.jsx";
import { ToolItem } from "./ToolItem.jsx";
import { AgentBlock } from "./AgentBlock.jsx";
import { ThinkingLine } from "./ThinkingLine.jsx";
import { ProcessingLine } from "./ProcessingLine.jsx";
import { MessageTask } from "./MessageTask.jsx";
import { MessageRow } from "./MessageRow.jsx";
import { TerminalCard } from "./TerminalCard.jsx";
import { subscribe as subscribeTerminal, liveRunsFor, removeRun, clearWorkspaceRuns } from "../../../state/terminalStore.js";
import { setInputNeeded } from "../../../state/inputNeededStore.js";
import * as outbox from "../../../state/outboxStore.js";

const SCROLL_THRESHOLD = 40;
const BUTTON_THRESHOLD = 300;
// How many older pages the initial restore may pull while hunting for a saved
// anchor that lives above the newest-page event window.
const MAX_RESTORE_PAGES = 3;

// Stable identity for the gated "not this agent's rows" case so downstream
// memos don't churn while a switch is in flight.
const NO_EVENTS = [];

export function Messages({ live, agentId, isActive = true }) {
  const ui = useUi();
  // This pane renders exactly ONE agent. The host passes agentId explicitly so
  // several panes can stay mounted at once (keep-alive); a lone <Messages> with
  // no host falls back to the global selection. isActive marks the visible pane —
  // only it drives shared UI state (question banner, verdict, agent viewer,
  // header scrim, ⌘F). Parked panes keep fetching/rendering but stay silent.
  const selectedId = agentId !== undefined ? agentId : ui.selectedId;
  const initialScrollDone = useRef(false);
  const lastTopRef = useRef(0);

  // Persist the user's position per agent; pinned clears the entry so the
  // default stick-to-bottom resumes. Skipped until the initial scroll lands —
  // content-swap clamp events during an agent switch must not save.
  const persistAway = useCallback(() => {
    if (!initialScrollDone.current || !selectedId) return;
    const anchor = captureAnchor(wrapRef.current, contentRef.current);
    if (anchor) saveScrollPos(selectedId, anchor);
  }, [selectedId]);
  const persistPinned = useCallback(() => {
    if (initialScrollDone.current && selectedId) clearScrollPos(selectedId);
  }, [selectedId]);

  // The header's fade-out scrim (.head::after) paints over the first ~2 lines
  // of content — hide it while the view sits at the very top so the start of
  // the transcript is never veiled.
  const syncHeadScrim = useCallback((el) => {
    if (!isActive || !el) return;
    // Remember the live offset so a parked→active flip can restore it if the
    // platform dropped scrollTop while the pane was content-hidden.
    lastTopRef.current = el.scrollTop;
    el.closest(".center")?.classList.toggle("msgs-at-top", el.scrollTop <= 4);
  }, [isActive]);

  const stick = useStickToBottom({
    threshold: SCROLL_THRESHOLD,
    buttonThreshold: BUTTON_THRESHOLD,
    onUserAway: persistAway,
    onPinned: persistPinned,
    onScroll: syncHeadScrim,
  });
  const wrapRef = stick.scrollerRef;
  const contentRef = stick.contentRef;

  const scrollToBottom = useCallback(() => {
    if (selectedId) clearScrollPos(selectedId);
    stick.scrollToBottom();
  }, [stick.scrollToBottom, selectedId]);

  const restorePagesRef = useRef(0);
  useEffect(() => {
    initialScrollDone.current = false;
    restorePagesRef.current = 0;
    stick.reset();
  }, [selectedId, stick.reset]);

  // Durable rows settle outbox items (clientMsgId echo, text fallback,
  // delivery_failed) — the matching logic lives in the store.
  const reconcileFromNewest = useCallback((workerId, rows) => {
    outbox.reconcileEvents(workerId, rows);
  }, []);

  // `eventsFor` = which agent the current window belongs to. Ownership gate:
  // a window still holding another agent's rows (mid-switch, or any future
  // regression upstream) renders as empty — never as the wrong transcript.
  // The initial scroll likewise waits for the new agent's content before
  // restoring a saved position.
  const {
    events: windowEvents, eventsFor, hasOlder: windowHasOlder,
    loadingOlder, loadOlder, fetchDelta,
  } = useWorkerEvents(
    selectedId,
    { restartKey: live.workers.length, onNewest: reconcileFromNewest },
  );
  const owned = eventsFor === selectedId;
  const events = owned ? windowEvents : NO_EVENTS;
  const hasOlder = owned && windowHasOlder;

  useEffect(() => {
    if (live.eventSignal.workerId !== selectedId) return;
    fetchDelta();
  }, [live.eventSignal.tick]);

  // "Load older" sentinel at the top of the list. Before each load, anchor the
  // current scroll geometry; once older rows land, shift scrollTop by the
  // height delta so the viewport keeps showing the same content. (A bottom
  // append racing the in-flight fetch would skew the delta slightly — rare
  // enough to accept over per-block DOM anchoring.)
  const prependAnchorRef = useRef(null);
  const triggerLoadOlderRef = useRef(() => {});
  triggerLoadOlderRef.current = () => {
    if (!hasOlder || loadingOlder) return;
    const el = wrapRef.current;
    if (el) {
      prependAnchorRef.current = {
        firstId: events[0]?.id ?? null,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
      };
    }
    loadOlder();
  };
  const [sentinelEl, setSentinelEl] = useState(null);
  useEffect(() => {
    if (!sentinelEl || !wrapRef.current) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) triggerLoadOlderRef.current(); },
      // ~2 viewports of look-ahead: with the store's read-ahead prefetch the
      // page is usually already in memory by the time the sentinel trips.
      { root: wrapRef.current, rootMargin: "1600px 0px 0px 0px" },
    );
    io.observe(sentinelEl);
    return () => io.disconnect();
  }, [sentinelEl]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const el = wrapRef.current;
    if (!anchor || !el) return;
    if ((events[0]?.id ?? null) === anchor.firstId) return; // nothing prepended yet
    prependAnchorRef.current = null;
    stick.write(anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight), { pin: "keep" });
  }, [events]);

  const pendingQuestions = useMemo(() => derivePendingQuestions(events), [events]);

  useEffect(() => {
    if (!isActive) return;
    // Sequential answering: surface only the first open question as the active banner.
    ui.setPendingQuestion(pendingQuestions[0] ?? null);
  }, [pendingQuestions, isActive]);

  // Per-agent "needs input" signal for split-pane badges — published un-gated by
  // isActive (a non-focused pane has no banner, so its badge is the only cue).
  // Dismissed questions don't count; cleared on switch/unmount.
  useEffect(() => {
    const open = pendingQuestions.some((q) => !ui.dismissedQuestions?.has(q.toolUseId));
    setInputNeeded(selectedId, open);
    return () => setInputNeeded(selectedId, false);
  }, [pendingQuestions, selectedId, ui.dismissedQuestions]);

  // Publish verification verdicts for the chip consumers (diff row/viewer).
  // Orchestrators get no self-verdict — their transcript merely ECHOES worker
  // Handover lines (a chip on the orchestrator's own repo row would lie);
  // instead each worker_report yields a per-child verdict for the hub strip.
  const verdict = useMemo(() => deriveVerdict(events), [events]);
  const childVerdicts = useMemo(() => deriveChildVerdicts(events), [events]);
  useEffect(() => {
    if (!isActive || eventsFor !== selectedId) return;
    const isOrch = Boolean(live.workers.find((w) => w.id === selectedId)?.is_orchestrator);
    ui.setVerdict({
      workerId: selectedId,
      ...(isOrch ? { verdict: "unverified", command: null, ts: null } : verdict),
      children: childVerdicts,
    });
  }, [verdict, childVerdicts, selectedId, live.workers, eventsFor, isActive]);

  // Live terminal runs (composer `!` mode) stream outside the event store —
  // a tick subscription re-renders on every chunk.
  const [termTick, setTermTick] = useState(0);
  useEffect(() => subscribeTerminal(() => setTermTick((t) => t + 1)), []);

  // Outbox bubbles (sending/dispatching) overlay the durable blocks the same
  // way — they live in a module store, not React state.
  const [outboxTick, setOutboxTick] = useState(0);
  useEffect(() => outbox.subscribe(() => setOutboxTick((t) => t + 1)), []);

  // Selecting an agent retires the no-selection workspace cards — the next
  // "new session" view starts clean. Still-running commands get killed.
  useEffect(() => {
    if (!isActive || !selectedId) return;
    for (const r of clearWorkspaceRuns()) {
      if (!r.done) api.killTerminal(r.runId);
    }
  }, [selectedId, isActive]);

  const selectedWorker = live.workers.find((w) => w.id === selectedId);
  // A primitive on purpose: live.workers churns on every state ping, but the
  // parse only cares whether the boot prompt renders as a task card.
  const bootPromptOffset = selectedWorker?.parent_id && selectedWorker?.prompt ? 1 : 0;

  // Parse is the expensive half (full-transcript scan) — it re-runs only when
  // durable rows change. Overlays join in the second memo so terminal chunks
  // and outbox ticks re-sort without re-parsing everything.
  const baseBlocks = useMemo(
    () => buildBlocks(applyRewinds(applyClears(events), { bootPromptOffset })),
    [events, bootPromptOffset],
  );

  const blocks = useMemo(() => {
    const base = baseBlocks.slice();
    // Queued items render as pills above the input bar, not here; the bubble
    // states (sending/dispatching) join the sort so a drained message lands
    // exactly where its durable event will (see outboxStore.js).
    for (const m of outbox.itemsFor(selectedId)) {
      if (m.state === "queued") continue;
      base.push({ kind: "user", text: m.text, ts: m.ts, optimistic: true });
    }
    // Overlay live terminal runs whose durable `terminal` event hasn't landed.
    const durableRuns = new Set(base.filter((b) => b.kind === "terminal" && b.runId).map((b) => b.runId));
    for (const r of liveRunsFor(selectedId)) {
      if (durableRuns.has(r.runId)) continue;
      base.push({
        kind: "terminal", live: true, runId: r.runId, command: r.command,
        output: r.output, exitCode: r.exitCode, note: r.note,
        truncated: false, done: r.done, ts: r.ts,
      });
    }
    // Conversation position is ts (creation domain), not append order — see
    // sortBlocksByTs for the clock-domain rationale.
    return sortBlocksByTs(base);
  }, [baseBlocks, selectedId, termTick, outboxTick]);

  const rewindToMessage = useRewind(selectedId);
  // Duplicate user texts must map to the n-th identical transcript target —
  // each bubble's occurrence index among same-text bubbles, oldest first.
  const rewindOccurrence = useMemo(() => {
    const counts = new Map();
    const m = new Map();
    for (const b of blocks) {
      if (b.kind !== "user" || b.optimistic) continue;
      const k = normRewindText(b.text);
      const n = counts.get(k) ?? 0;
      m.set(b, n);
      counts.set(k, n + 1);
    }
    return m;
  }, [blocks]);

  // Drop a live run once its durable event is in the window — the durable
  // block has taken over rendering.
  useEffect(() => {
    const durable = new Set();
    for (const b of blocks) {
      if (b.kind === "terminal" && !b.live && b.runId) durable.add(b.runId);
    }
    if (durable.size === 0) return;
    for (const r of liveRunsFor(selectedId)) {
      if (durable.has(r.runId)) removeRun(r.runId);
    }
  }, [blocks, selectedId]);

  useEffect(() => {
    if (!isActive || !ui.agentViewer) return;
    const match = blocks.find(b => b.kind === "agentRun" && b.toolUseId === ui.agentViewer.toolUseId);
    if (match) ui.syncAgentViewer(match);
    // ui.agentViewer dep: re-sync when the agent panel returns to the top of
    // the panel stack (its block may have gone stale while buried).
  }, [blocks, ui.agentViewer, isActive]);

  // Blur-in baseline: blocks already present when an agent's transcript first
  // renders stay static; only blocks arriving afterwards animate. Re-baselined
  // on every agent switch so revisiting history never re-animates it.
  const baselineRef = useRef({ id: null, keys: null });
  if (baselineRef.current.id !== selectedId) baselineRef.current = { id: selectedId, keys: null };
  useEffect(() => {
    if (baselineRef.current.keys || eventsFor !== selectedId || blocks.length === 0) return;
    // Wait for the initial scroll/restore to settle before snapshotting. Restore
    // can page in older history (loadOlder) AFTER the newest page lands —
    // snapshotting too early leaves those older blocks out of the baseline, so on
    // a first visit they blur-in as if freshly arrived. Settling first means
    // every block loaded during entry counts as baseline (static); only output
    // arriving AFTER entry animates. (initialScrollDone flips in the layout
    // effect, which runs before this passive effect in the same commit.)
    if (!initialScrollDone.current) return;
    baselineRef.current.keys = new Set(blocks.map((b, i) => blockKey(b, i)));
  }, [blocks, selectedId, eventsFor]);
  const baselineKeys = baselineRef.current.keys;

  // expandedTools/settings in deps: expanding a tool mounts new text the ranges must cover.
  const find = usePageFind(contentRef, wrapRef, [blocks, ui.expandedTools, ui.settings], isActive);

  const parentWorker = selectedWorker?.parent_id
    ? live.workers.find((w) => w.id === selectedWorker.parent_id)
    : null;
  // live.workers already maps an interrupted agent to IDLE, so deriveActivity
  // sees the effective state.
  const { busy: agentBusy, elapsedMs: turnElapsedMs } = deriveActivity(selectedWorker, live.now);
  const interrupted = live.interruptedId === selectedWorker?.id;

  const lastBlock = blocks[blocks.length - 1];

  // (The old auto-flush effect lived here. Queued messages are now held and
  // drained by the DAEMON at the worker's IDLE transition — the view never
  // dispatches; see core/use-cases/DrainQueuedMessages.)
  const isAgentReply = lastBlock && (lastBlock.kind === "assistant" || lastBlock.kind === "toolGroup" || lastBlock.kind === "thinking" || lastBlock.kind === "agentRun");
  const showAnchor = !interrupted && (agentBusy || isAgentReply);

  // Layout effect: the initial scroll must land before paint, otherwise the
  // content flashes at the top and visibly jumps to the restored position.
  // Subsequent appends need no handling here — the hook's ResizeObserver
  // glides the view while pinned. A saved anchor that sits above the
  // newest-page window pulls older pages (bounded) — the effect re-runs as
  // rows land and retries the resolve; an anchor that never resolves (cleared
  // or rewound transcript, or beyond the budget) drops its stale entry and
  // falls back to the default bottom pin.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || blocks.length === 0) return;
    if (initialScrollDone.current) return;
    if (eventsFor !== selectedId) return;
    const saved = loadScrollPos(selectedId);
    if (saved != null) {
      const top = resolveAnchorTop(el, contentRef.current, saved);
      if (top != null) {
        initialScrollDone.current = true;
        stick.write(top);
        return;
      }
      if (hasOlder && !loadingOlder && restorePagesRef.current < MAX_RESTORE_PAGES) {
        restorePagesRef.current++;
        loadOlder();
        return;
      }
      if (loadingOlder) return;
      clearScrollPos(selectedId);
    }
    initialScrollDone.current = true;
    stick.write(Infinity, { pin: true });
  }, [blocks, hasOlder, loadingOlder]);

  // Parked→active flip: parking collapses the scroller (content-visibility:hidden)
  // so on re-show scrollTop has been reset to 0. Restore the position
  // SYNCHRONOUSLY, before paint — otherwise the ResizeObserver glides from the top
  // back down, which is the "slides down on every switch" artifact. Pinned panes
  // jump to the CURRENT bottom (content may have grown while parked); others to
  // the exact saved offset. write() is an instant own-write, never a glide.
  useLayoutEffect(() => {
    if (!isActive || !initialScrollDone.current) return;
    const el = wrapRef.current;
    if (!el) return;
    if (stick.isPinned()) {
      stick.write(Infinity, { pin: true });
    } else if (Math.abs(el.scrollTop - lastTopRef.current) > 1) {
      stick.write(lastTopRef.current, { pin: "keep" });
    }
  }, [isActive]);

  // Scroll position can change without a scroll event (content fill, agent
  // switch) — re-sync the scrim after every commit; clean it off on unmount.
  useLayoutEffect(() => { syncHeadScrim(wrapRef.current); });
  useEffect(() => {
    const center = wrapRef.current?.closest(".center");
    return () => center?.classList.remove("msgs-at-top");
  }, []);

  return (
    <ScrollHoldContext.Provider value={stick.hold}>
    <div className="messages-wrap" ref={wrapRef}>
      {find.open && <FindBar find={find} />}
      <div className={selectedId ? "messages" : "messages messages-empty"} ref={contentRef}>
        {selectedId && hasOlder && (
          <div className="load-older" ref={setSentinelEl}>
            {loadingOlder && <span className="load-older-skel" aria-label="loading earlier messages" />}
          </div>
        )}
        {selectedWorker?.parent_id && selectedWorker.prompt && (
          <MessageTask
            prompt={selectedWorker.prompt}
            parentId={selectedWorker.parent_id}
            parentName={parentWorker?.name || "orchestrator"}
            workers={live.workers}
          />
        )}
        {blocks.map((b, i) => {
          const isLast = i === blocks.length - 1;
          const key = blockKey(b, i);
          const animate = (b.kind === "assistant" || b.kind === "thinking" || b.kind === "terminal") && baselineKeys != null && !baselineKeys.has(key);
          const onRewind = b.kind === "user" && !b.optimistic
            ? () => rewindToMessage(b.text, rewindOccurrence.get(b) ?? 0)
            : null;
          const block = renderBlock(b, key, selectedWorker?.cwd, ui, live.workers, animate, parentWorker, onRewind, agentBusy);
          if (!block) return null;
          // The wrapper carries the block's scroll-anchor identity
          // (lib/scrollAnchor.js) so every block kind is anchorable without
          // threading a prop through each component.
          // `cv` opts a block into content-visibility (perf). MessageRow text
          // blocks are excluded: paint containment (implied by content-visibility)
          // would clip their hover action row, which overflows into the gap
          // below the wrapper. See styles.css.
          const cls = [
            isLast && interrupted && b.kind !== "user" ? "msg-interrupted-wrap" : null,
            MESSAGE_ROW_KINDS.has(b.kind) ? null : "cv",
          ].filter(Boolean).join(" ") || undefined;
          return <div key={key} data-bkey={key} className={cls}>{block}</div>;
        })}
        {showAnchor && (
          <ProcessingLine
            busy={agentBusy}
            elapsed={turnElapsedMs >= 1000 ? fmtElapsedShort(turnElapsedMs) : null}
          />
        )}
      </div>
      {stick.showJumpBtn && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} aria-label="Scroll to bottom">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
    </ScrollHoldContext.Provider>
  );
}

function blockKey(b, i) {
  switch (b.kind) {
    case "toolGroup": return "tg-" + (b.tools[0]?.id ?? b.ts ?? i);
    case "tool":      return "t-" + (b.tool.id ?? b.ts ?? i);
    case "agentRun":  return "ag-" + (b.toolUseId ?? b.ts ?? i);
    case "terminal":  return "term-" + (b.runId ?? b.ts ?? i);
    default:          return b.kind + "-" + (b.ts ?? i);
  }
}

// Block kinds rendered via MessageRow — they carry a hover action row
// (copy/rewind/timestamp) absolutely positioned in the gap below the wrapper.
// Such blocks must NOT get content-visibility, whose paint containment clips it.
const MESSAGE_ROW_KINDS = new Set(["user", "report", "directive", "peer-request", "assistant"]);

function renderBlock(b, key, cwd, ui, workers, animate, parent, onRewind, rewindDisabled) {
  switch (b.kind) {
    case "user":      return <MessageRow key={key} ts={b.ts} copyText={b.text} align="right" onRewind={onRewind} rewindDisabled={rewindDisabled}><MessageUser text={b.text} cwd={cwd} /></MessageRow>;
    case "report":    return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} agentId={b.fromWorker} agentName={b.workerName} workers={workers} direction="in" /></MessageRow>;
    case "directive": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} agentId={b.fromParent} agentName={b.parentName} workers={workers} direction="out" /></MessageRow>;
    case "peer-request": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} agentId={b.fromWorker} agentName={b.fromName} workers={workers} direction="in" label="Peer request from" /></MessageRow>;
    case "assistant": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageAssistant text={b.text} animate={animate} /></MessageRow>;
    case "thinking":  return <ThinkingLine key={key} text={b.text} animate={animate} />;
    case "toolGroup": {
      const groupKey = "g:" + (b.tools[0]?.id ?? b.ts);
      // expandedTools holds toggles against the settings-driven default (XOR)
      const open = defaultGroupOpen(b.tools, ui.settings) !== ui.expandedTools.has(groupKey);
      return <ToolGroup key={key} summary={b.summary} tools={b.tools} cwd={cwd} workers={workers}
        open={open} onToggle={() => ui.toggleToolExpanded(groupKey)} />;
    }
    case "tool":      return <ToolItem key={key} tool={b.tool} standalone cwd={cwd} workers={workers} parent={parent} />;
    case "terminal":  return <TerminalCard key={key} block={b} fresh={animate} />;
    case "agentRun":  return <AgentBlock key={key} block={b} />;
    case "deliveryFailed":
      return (
        <div key={key} className="delivery-failed mono">
          message was not delivered{b.text ? ` — “${b.text}”` : ""} · try sending again
        </div>
      );
    case "cleared":
      return (
        <div key={key} className="conversation-cleared mono">
          conversation cleared
        </div>
      );
    case "push":
      return (
        <div key={key} className={"git-push-line mono" + (b.ok ? " ok" : " err")}>
          <span className="gp-icon" aria-hidden>{b.ok ? "↑" : "!"}</span>
          <span className="gp-msg">{b.message}</span>
          {b.branch && <span className="gp-branch">{b.branch}</span>}
        </div>
      );
    case "pull":
      return (
        <div key={key} className={"git-push-line mono" + (b.ok ? " ok" : " err")}>
          <span className="gp-icon" aria-hidden>{b.ok ? "↓" : "!"}</span>
          <span className="gp-msg">{b.message}</span>
          {b.branch && <span className="gp-branch">{b.branch}</span>}
        </div>
      );
    case "worktreePreserved": {
      const fileCount = (b.diffStat ?? "").trim().split("\n").filter(Boolean).length;
      return (
        <div key={key} className="worktree-preserved mono">
          <span className="wp-title">Worktree preserved</span>
          <span className="wp-detail">
            {b.branch} · {fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"} changed` : "uncommitted changes"} · {b.path}
          </span>
          <button className="wp-btn" onClick={() => api.revealFile(b.path)}>Reveal</button>
        </div>
      );
    }
    default: return null;
  }
}

