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
import { buildBlocks, applyRewinds, applyClears, parsePayload } from "../../../lib/messageParser.js";
import { deriveVerdict, deriveChildVerdicts } from "../../../lib/verdict.js";
import { derivePendingQuestions } from "../../../lib/pendingQuestions.js";
import { loadScrollPos, saveScrollPos, clearScrollPos } from "../../../lib/scrollMemory.js";
import { usePageFind } from "../../../hooks/usePageFind.js";
import { useWorkerEvents } from "../../../hooks/useWorkerEvents.js";
import { useStickToBottom } from "../../../hooks/useStickToBottom.js";
import { defaultGroupOpen } from "../../../settings/toolExpansion.js";
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

const SCROLL_THRESHOLD = 40;
const BUTTON_THRESHOLD = 300;

export function Messages({ live }) {
  const ui = useUi();
  const initialScrollDone = useRef(false);

  // Persist the user's position per agent; pinned clears the entry so the
  // default stick-to-bottom resumes. Skipped until the initial scroll lands —
  // content-swap clamp events during an agent switch must not save.
  const persistAway = useCallback((top) => {
    if (initialScrollDone.current && ui.selectedId) saveScrollPos(ui.selectedId, top);
  }, [ui.selectedId]);
  const persistPinned = useCallback(() => {
    if (initialScrollDone.current && ui.selectedId) clearScrollPos(ui.selectedId);
  }, [ui.selectedId]);

  // The header's fade-out scrim (.head::after) paints over the first ~2 lines
  // of content — hide it while the view sits at the very top so the start of
  // the transcript is never veiled.
  const syncHeadScrim = useCallback((el) => {
    el?.closest(".center")?.classList.toggle("msgs-at-top", el.scrollTop <= 4);
  }, []);

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
    if (ui.selectedId) clearScrollPos(ui.selectedId);
    stick.scrollToBottom();
  }, [stick.scrollToBottom, ui.selectedId]);

  useEffect(() => {
    initialScrollDone.current = false;
    stick.reset();
  }, [ui.selectedId, stick.reset]);

  const reconcileFromNewest = useCallback((workerId, rows) => {
    const texts = new Set();
    const ids = new Set();
    const failures = [];
    for (const e of rows) {
      const p = parsePayload(e.payload);
      if (e.type === "user_message") {
        if (p.text) texts.add(p.text);
        // clientMsgIds echoed by the worker — the authoritative settle signal.
        for (const cid of p.clientMsgIds ?? []) ids.add(cid);
      }
      // A failed delivery never yields a user_message — the failure event
      // itself must release the optimistic copy.
      if (e.type === "lifecycle" && p.phase === "delivery_failed" && p.text) {
        failures.push({ text: p.text, ts: e.ts });
      }
    }
    ui.reconcileOptimisticMessages(workerId, { ids, texts, failures });
  }, [ui.reconcileOptimisticMessages]);

  // `eventsFor` = which agent the current `events` belong to — during a
  // switch, blocks still render the previous agent's rows, and the initial
  // scroll must wait for the new agent's content before restoring a saved
  // position.
  const { events, eventsFor, hasOlder, loadingOlder, loadOlder, refetchNewest } = useWorkerEvents(
    ui.selectedId,
    { restartKey: live.workers.length, onNewest: reconcileFromNewest },
  );

  useEffect(() => {
    if (live.eventSignal.workerId !== ui.selectedId) return;
    refetchNewest();
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
      { root: wrapRef.current, rootMargin: "200px 0px 0px 0px" },
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
    // Sequential answering: surface only the first open question as the active banner.
    ui.setPendingQuestion(pendingQuestions[0] ?? null);
  }, [pendingQuestions]);

  // Publish verification verdicts for the chip consumers (diff row/viewer).
  // Orchestrators get no self-verdict — their transcript merely ECHOES worker
  // Handover lines (a chip on the orchestrator's own repo row would lie);
  // instead each worker_report yields a per-child verdict for the hub strip.
  const verdict = useMemo(() => deriveVerdict(events), [events]);
  const childVerdicts = useMemo(() => deriveChildVerdicts(events), [events]);
  useEffect(() => {
    if (eventsFor !== ui.selectedId) return;
    const isOrch = Boolean(live.workers.find((w) => w.id === ui.selectedId)?.is_orchestrator);
    ui.setVerdict({
      workerId: ui.selectedId,
      ...(isOrch ? { verdict: "unverified", command: null, ts: null } : verdict),
      children: childVerdicts,
    });
  }, [verdict, childVerdicts, ui.selectedId, live.workers, eventsFor]);

  // Live terminal runs (composer `!` mode) stream outside the event store —
  // a tick subscription re-renders on every chunk.
  const [termTick, setTermTick] = useState(0);
  useEffect(() => subscribeTerminal(() => setTermTick((t) => t + 1)), []);

  // Selecting an agent retires the no-selection workspace cards — the next
  // "new session" view starts clean. Still-running commands get killed.
  useEffect(() => {
    if (!ui.selectedId) return;
    for (const r of clearWorkspaceRuns()) {
      if (!r.done) api.killTerminal(r.runId);
    }
  }, [ui.selectedId]);

  const blocks = useMemo(() => {
    const w = live.workers.find((x) => x.id === ui.selectedId);
    const bootPromptOffset = w?.parent_id && w?.prompt ? 1 : 0;
    const base = buildBlocks(applyRewinds(applyClears(events), { bootPromptOffset }));
    const opt = ui.optimisticMsgs.get(ui.selectedId) ?? [];
    for (const m of opt) {
      base.push({ kind: "user", text: m.text, ts: m.ts, optimistic: true });
    }
    // Overlay live terminal runs whose durable `terminal` event hasn't landed.
    const durableRuns = new Set(base.filter((b) => b.kind === "terminal" && b.runId).map((b) => b.runId));
    for (const r of liveRunsFor(ui.selectedId)) {
      if (durableRuns.has(r.runId)) continue;
      base.push({
        kind: "terminal", live: true, runId: r.runId, command: r.command,
        output: r.output, exitCode: r.exitCode, note: r.note,
        truncated: false, done: r.done, ts: r.ts,
      });
    }
    return base;
  }, [events, ui.optimisticMsgs, ui.selectedId, live.workers, termTick]);

  // Drop a live run once its durable event is in the window — the durable
  // block has taken over rendering.
  useEffect(() => {
    const durable = new Set();
    for (const b of blocks) {
      if (b.kind === "terminal" && !b.live && b.runId) durable.add(b.runId);
    }
    if (durable.size === 0) return;
    for (const r of liveRunsFor(ui.selectedId)) {
      if (durable.has(r.runId)) removeRun(r.runId);
    }
  }, [blocks, ui.selectedId]);

  useEffect(() => {
    if (!ui.agentViewer) return;
    const match = blocks.find(b => b.kind === "agentRun" && b.toolUseId === ui.agentViewer.toolUseId);
    if (match) ui.syncAgentViewer(match);
    // ui.agentViewer dep: re-sync when the agent panel returns to the top of
    // the panel stack (its block may have gone stale while buried).
  }, [blocks, ui.agentViewer]);

  // Blur-in baseline: blocks already present when an agent's transcript first
  // renders stay static; only blocks arriving afterwards animate. Re-baselined
  // on every agent switch so revisiting history never re-animates it.
  const baselineRef = useRef({ id: null, keys: null });
  if (baselineRef.current.id !== ui.selectedId) baselineRef.current = { id: ui.selectedId, keys: null };
  useEffect(() => {
    if (baselineRef.current.keys || eventsFor !== ui.selectedId || blocks.length === 0) return;
    baselineRef.current.keys = new Set(blocks.map((b, i) => blockKey(b, i)));
  }, [blocks, ui.selectedId, eventsFor]);
  const baselineKeys = baselineRef.current.keys;

  // expandedTools/settings in deps: expanding a tool mounts new text the ranges must cover.
  const find = usePageFind(contentRef, wrapRef, [blocks, ui.expandedTools, ui.settings]);

  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
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
  // glides the view while pinned.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || blocks.length === 0) return;
    if (initialScrollDone.current) return;
    if (eventsFor !== ui.selectedId) return;
    initialScrollDone.current = true;
    const saved = loadScrollPos(ui.selectedId);
    if (saved != null) stick.write(saved);
    else stick.write(Infinity, { pin: true });
  }, [blocks]);

  // Scroll position can change without a scroll event (content fill, agent
  // switch) — re-sync the scrim after every commit; clean it off on unmount.
  useLayoutEffect(() => { syncHeadScrim(wrapRef.current); });
  useEffect(() => {
    const center = wrapRef.current?.closest(".center");
    return () => center?.classList.remove("msgs-at-top");
  }, []);

  return (
    <div className="messages-wrap" ref={wrapRef}>
      {find.open && <FindBar find={find} />}
      <div className={ui.selectedId ? "messages" : "messages messages-empty"} ref={contentRef}>
        {ui.selectedId && hasOlder && (
          <div className="load-older" ref={setSentinelEl}>
            {loadingOlder ? "loading earlier messages…" : ""}
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
          const animate = (b.kind === "assistant" || b.kind === "thinking") && baselineKeys != null && !baselineKeys.has(key);
          const block = renderBlock(b, key, selectedWorker?.cwd, ui, live.workers, animate, parentWorker);
          if (isLast && interrupted && b.kind !== "user") {
            return <div key={key} className="msg-interrupted-wrap">{block}</div>;
          }
          return block;
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

function renderBlock(b, key, cwd, ui, workers, animate, parent) {
  switch (b.kind) {
    case "user":      return <MessageRow key={key} ts={b.ts} copyText={b.text} align="right"><MessageUser text={b.text} cwd={cwd} /></MessageRow>;
    case "report":    return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} agentId={b.fromWorker} agentName={b.workerName} workers={workers} direction="in" /></MessageRow>;
    case "directive": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} agentId={b.fromParent} agentName={b.parentName} workers={workers} direction="out" /></MessageRow>;
    case "assistant": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageAssistant text={b.text} animate={animate} /></MessageRow>;
    case "thinking":  return <ThinkingLine key={key} text={b.text} animate={animate} />;
    case "toolGroup": {
      const groupKey = "g:" + (b.tools[0]?.id ?? b.ts);
      // expandedTools holds toggles against the settings-driven default (XOR)
      const open = defaultGroupOpen(b.tools, ui.settings) !== ui.expandedTools.has(groupKey);
      return <ToolGroup key={key} summary={b.summary} tools={b.tools} cwd={cwd}
        open={open} onToggle={() => ui.toggleToolExpanded(groupKey)} />;
    }
    case "tool":      return <ToolItem key={key} tool={b.tool} standalone cwd={cwd} workers={workers} parent={parent} />;
    case "terminal":  return <TerminalCard key={key} block={b} />;
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

