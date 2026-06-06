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
import { buildBlocks, parsePayload } from "../../../lib/messageParser.js";
import { derivePendingQuestions } from "../../../lib/pendingQuestions.js";
import { shouldStick, shouldAutoScroll } from "../../../lib/scrollStick.js";
import { loadScrollPos, saveScrollPos, clearScrollPos } from "../../../lib/scrollMemory.js";
import { usePageFind } from "../../../hooks/usePageFind.js";
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

const POLL_MS = 5000;
const SCROLL_THRESHOLD = 40;
const BUTTON_THRESHOLD = 300;

export function Messages({ live }) {
  const ui = useUi();
  const [events, setEvents] = useState([]);
  const wrapRef = useRef(null);
  const contentRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottomRef = useRef(true);
  const initialScrollDone = useRef(false);
  const programmaticScrollRef = useRef(false);
  const lastUserScrollTsRef = useRef(0);

  const updateScrollBtn = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const overflows = el.scrollHeight > el.clientHeight;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(overflows && dist >= BUTTON_THRESHOLD);
  }, []);

  const checkNearBottom = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (!programmaticScrollRef.current) {
      lastUserScrollTsRef.current = performance.now();
      isNearBottomRef.current = shouldStick(
        { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight },
        SCROLL_THRESHOLD,
      );
      // Persist the user's position per agent; near-bottom clears the entry so
      // the default stick-to-bottom resumes. Skipped until the initial scroll
      // lands — content-swap clamp events during an agent switch must not save.
      if (initialScrollDone.current && ui.selectedId) {
        if (isNearBottomRef.current) clearScrollPos(ui.selectedId);
        else saveScrollPos(ui.selectedId, el.scrollTop);
      }
    }
    updateScrollBtn();
  }, [updateScrollBtn, ui.selectedId]);

  useEffect(() => {
    const el = wrapRef.current;
    const content = contentRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkNearBottom, { passive: true });
    // Content can shrink without a scroll event (e.g. collapsing a task);
    // re-evaluate the button on size changes so it doesn't get stuck visible.
    const ro = new ResizeObserver(updateScrollBtn);
    ro.observe(el);
    if (content) ro.observe(content);
    return () => { el.removeEventListener("scroll", checkNearBottom); ro.disconnect(); };
  }, [checkNearBottom, updateScrollBtn]);

  // Guard code-initiated scrolls so the animation's own scroll events don't
  // unpin the view. WKWebView may never fire scrollend, so the 200ms fallback
  // that clears the guard is mandatory.
  const runProgrammaticScroll = useCallback((el, writeFn) => {
    programmaticScrollRef.current = true;
    const clear = () => {
      el.removeEventListener("scrollend", clear);
      programmaticScrollRef.current = false;
    };
    writeFn();
    el.addEventListener("scrollend", clear, { once: true });
    setTimeout(clear, 200);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    isNearBottomRef.current = true;
    if (ui.selectedId) clearScrollPos(ui.selectedId);
    runProgrammaticScroll(el, () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  }, [runProgrammaticScroll, ui.selectedId]);

  const fetchRef = useRef(null);
  // Which agent the current `events` belong to — during a switch, blocks still
  // render the previous agent's rows, and the initial scroll must wait for the
  // new agent's content before restoring a saved position.
  const eventsForRef = useRef(null);

  useEffect(() => { initialScrollDone.current = false; }, [ui.selectedId]);

  useEffect(() => {
    if (!ui.selectedId) { setEvents([]); fetchRef.current = null; eventsForRef.current = null; return; }
    const ac = new AbortController();
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const rows = await api.getWorkerEvents(ui.selectedId, { limit: 500, order: "asc", signal: ac.signal });
        if (!cancelled && Array.isArray(rows)) {
          eventsForRef.current = ui.selectedId;
          setEvents(rows);
          const serverTexts = new Set();
          for (const e of rows) {
            if (e.type !== "user_message") continue;
            const p = parsePayload(e.payload);
            if (p.text) serverTexts.add(p.text);
          }
          ui.reconcileOptimisticMessages(ui.selectedId, serverTexts);
        }
      } catch (e) {
        if (e?.name === "AbortError") return;
        if (!cancelled) { eventsForRef.current = ui.selectedId; setEvents([]); }
      }
    };
    fetchRef.current = fetchOnce;
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(t); ac.abort(); fetchRef.current = null; };
  }, [ui.selectedId, live.workers.length, ui.reconcileOptimisticMessages]);

  useEffect(() => {
    if (live.eventSignal.workerId !== ui.selectedId) return;
    fetchRef.current?.();
  }, [live.eventSignal.tick]);

  const pendingQuestions = useMemo(() => derivePendingQuestions(events), [events]);

  useEffect(() => {
    // Sequential answering: surface only the first open question as the active banner.
    ui.setPendingQuestion(pendingQuestions[0] ?? null);
  }, [pendingQuestions]);

  const blocks = useMemo(() => {
    const base = buildBlocks(events);
    const opt = ui.optimisticMsgs.get(ui.selectedId) ?? [];
    for (const m of opt) {
      base.push({ kind: "user", text: m.text, ts: m.ts, optimistic: true });
    }
    return base;
  }, [events, ui.optimisticMsgs, ui.selectedId]);

  useEffect(() => {
    if (!ui.agentViewer) return;
    const match = blocks.find(b => b.kind === "agentRun" && b.toolUseId === ui.agentViewer.toolUseId);
    if (match) ui.syncAgentViewer(match);
  }, [blocks]);

  // expandedTools/settings in deps: expanding a tool mounts new text the ranges must cover.
  const find = usePageFind(contentRef, wrapRef, [blocks, ui.expandedTools, ui.settings]);

  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const parentWorker = selectedWorker?.parent_id
    ? live.workers.find((w) => w.id === selectedWorker.parent_id)
    : null;
  const agentBusy = selectedWorker && (selectedWorker.state === "SPAWNING" || selectedWorker.state === "WORKING");
  const interrupted = live.interruptedId === selectedWorker?.id;

  const lastBlock = blocks[blocks.length - 1];

  // Auto-flush queued messages once the agent's response is actually rendered.
  // Arms on busy→idle; fires when blocks update and last block is agent output.
  const flushArmedRef = useRef(false);
  const prevBusyRef = useRef(agentBusy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = agentBusy;
    if (agentBusy) { flushArmedRef.current = false; return; }
    if (interrupted) { flushArmedRef.current = false; return; }
    if (wasBusy && !agentBusy && selectedWorker) {
      const q = ui.queuedMessages.get(selectedWorker.id);
      if (q && q.length > 0) flushArmedRef.current = true;
    }
    if (!flushArmedRef.current || !selectedWorker) return;
    if (!lastBlock || lastBlock.kind === "user") return;
    flushArmedRef.current = false;
    const list = ui.queuedMessages.get(selectedWorker.id);
    if (!list || list.length === 0) return;
    const combined = list.map((m) => m.text).join("\n\n");
    ui.clearQueuedMessages(selectedWorker.id);
    ui.addOptimisticUserMessage(selectedWorker.id, combined);
    live.sendToAgent(selectedWorker.id, combined);
  }, [agentBusy, blocks, interrupted]);
  const lastIsUser = !!(lastBlock && lastBlock.kind === "user");
  const isAgentReply = lastBlock && (lastBlock.kind === "assistant" || lastBlock.kind === "toolGroup" || lastBlock.kind === "thinking" || lastBlock.kind === "agentRun");
  let lastUserTs = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "user") { lastUserTs = blocks[i].ts; break; }
  }
  const waitingElapsedMs = agentBusy && lastIsUser && lastUserTs ? Math.max(0, live.now - lastUserTs) : 0;
  const showAnchor = !interrupted && ((agentBusy && blocks.length > 0) || isAgentReply);

  // Layout effect: the initial scroll must land before paint, otherwise the
  // content flashes at the top and visibly jumps to the restored position.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || blocks.length === 0) return;
    if (!initialScrollDone.current) {
      if (eventsForRef.current !== ui.selectedId) return;
      initialScrollDone.current = true;
      const saved = loadScrollPos(ui.selectedId);
      if (saved != null) {
        el.scrollTop = saved;
        isNearBottomRef.current = shouldStick(
          { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight },
          SCROLL_THRESHOLD,
        );
      } else {
        el.scrollTop = el.scrollHeight;
        isNearBottomRef.current = true;
      }
      return;
    }
    const msSinceUserScroll = performance.now() - lastUserScrollTsRef.current;
    if (!shouldAutoScroll(isNearBottomRef.current, programmaticScrollRef.current, msSinceUserScroll)) return;
    runProgrammaticScroll(el, () => { el.scrollTop = el.scrollHeight; });
  }, [blocks]);

  return (
    <div className="messages-wrap" ref={wrapRef}>
      {find.open && <FindBar find={find} />}
      <div className="messages" ref={contentRef}>
        {selectedWorker?.parent_id && selectedWorker.prompt && (
          <MessageTask
            prompt={selectedWorker.prompt}
            parentName={parentWorker?.name || "orchestrator"}
          />
        )}
        {blocks.map((b, i) => {
          const isLast = i === blocks.length - 1;
          const key = blockKey(b, i);
          const block = renderBlock(b, key, selectedWorker?.cwd, ui);
          if (isLast && interrupted && b.kind !== "user") {
            return <div key={key} className="msg-interrupted-wrap">{block}</div>;
          }
          return block;
        })}
        {showAnchor && (
          <ProcessingLine
            busy={!!agentBusy}
            elapsed={agentBusy && lastIsUser && lastUserTs && waitingElapsedMs >= 1000 ? fmtElapsedShort(waitingElapsedMs) : null}
          />
        )}
      </div>
      {showScrollBtn && (
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
    default:          return b.kind + "-" + (b.ts ?? i);
  }
}

function renderBlock(b, key, cwd, ui) {
  switch (b.kind) {
    case "user":      return <MessageRow key={key} ts={b.ts} copyText={b.text} align="right"><MessageUser text={b.text} cwd={cwd} /></MessageRow>;
    case "report":    return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} label={b.workerName || b.fromWorker || "worker"} direction="in" /></MessageRow>;
    case "directive": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageReport text={b.text} label={b.parentName || b.fromParent || "orchestrator"} direction="out" /></MessageRow>;
    case "assistant": return <MessageRow key={key} ts={b.ts} copyText={b.text}><MessageAssistant text={b.text} /></MessageRow>;
    case "thinking":  return <ThinkingLine key={key} text={b.text} ms={b.ms} />;
    case "toolGroup": {
      const groupKey = "g:" + (b.tools[0]?.id ?? b.ts);
      // expandedTools holds toggles against the settings-driven default (XOR)
      const open = defaultGroupOpen(b.tools, ui.settings) !== ui.expandedTools.has(groupKey);
      return <ToolGroup key={key} summary={b.summary} tools={b.tools} cwd={cwd}
        open={open} onToggle={() => ui.toggleToolExpanded(groupKey)} />;
    }
    case "tool":      return <ToolItem key={key} tool={b.tool} standalone cwd={cwd} />;
    case "agentRun":  return <AgentBlock key={key} block={b} />;
    default: return null;
  }
}

