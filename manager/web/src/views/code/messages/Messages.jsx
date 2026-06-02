// Messages — renders the transcript for the selected agent. Pulls events
// for the selection via /workers/:id/events and maps each event type to a
// renderable block.
//
// This is the initial render layer; refinement (tool-group collapse, file
// chips, table rendering) lives in dedicated sub-components.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { fmtElapsedShort } from "../../../lib/format.js";
import { buildBlocks, parsePayload } from "../../../lib/messageParser.js";
import { derivePendingQuestions } from "../../../lib/pendingQuestions.js";
import { shouldStick, shouldAutoScroll } from "../../../lib/scrollStick.js";
import { MessageUser } from "./MessageUser.jsx";
import { MessageReport } from "./MessageReport.jsx";
import { MessageAssistant } from "./MessageAssistant.jsx";
import { ToolGroup } from "./ToolGroup.jsx";
import { ToolItem } from "./ToolItem.jsx";
import { AgentBlock } from "./AgentBlock.jsx";
import { ThinkingLine } from "./ThinkingLine.jsx";
import { ProcessingLine } from "./ProcessingLine.jsx";
import { MessageTask } from "./MessageTask.jsx";

const POLL_MS = 5000;
const SCROLL_THRESHOLD = 40;
const BUTTON_THRESHOLD = 300;

export function Messages({ live }) {
  const ui = useUi();
  const [events, setEvents] = useState([]);
  const wrapRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottomRef = useRef(true);
  const initialScrollDone = useRef(false);
  const programmaticScrollRef = useRef(false);
  const lastUserScrollTsRef = useRef(0);

  const checkNearBottom = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const overflows = el.scrollHeight > el.clientHeight;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!programmaticScrollRef.current) {
      lastUserScrollTsRef.current = performance.now();
      isNearBottomRef.current = shouldStick(
        { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight },
        SCROLL_THRESHOLD,
      );
    }
    setShowScrollBtn(overflows && dist >= BUTTON_THRESHOLD);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => el.removeEventListener("scroll", checkNearBottom);
  }, [checkNearBottom]);

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
    runProgrammaticScroll(el, () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  }, [runProgrammaticScroll]);

  const fetchRef = useRef(null);

  useEffect(() => { initialScrollDone.current = false; }, [ui.selectedId]);

  useEffect(() => {
    if (!ui.selectedId) { setEvents([]); fetchRef.current = null; return; }
    const ac = new AbortController();
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const rows = await api.getWorkerEvents(ui.selectedId, { limit: 500, order: "asc", signal: ac.signal });
        if (!cancelled && Array.isArray(rows)) {
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
        if (!cancelled) setEvents([]);
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

  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const parentWorker = selectedWorker?.parent_id
    ? live.workers.find((w) => w.id === selectedWorker.parent_id)
    : null;
  const agentBusy = selectedWorker && (selectedWorker.state === "SPAWNING" || selectedWorker.state === "WORKING");
  const interrupted = live.interruptedId === selectedWorker?.id;

  // The worker's boot prompt was never acknowledged (no hook / no JSONL): it
  // sits IDLE having never started. Surface a resend so a silent loss is
  // actionable instead of looking like a finished agent.
  const promptLost = useMemo(() => {
    if (!selectedWorker || selectedWorker.state !== "IDLE") return false;
    let lastReason = null;
    for (const ev of events) {
      if (ev.type === "state") lastReason = parsePayload(ev.payload)?.reason ?? null;
    }
    return lastReason === "prompt_lost";
  }, [events, selectedWorker?.state]);

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

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || blocks.length === 0) return;
    if (!initialScrollDone.current) {
      initialScrollDone.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const msSinceUserScroll = performance.now() - lastUserScrollTsRef.current;
    if (!shouldAutoScroll(isNearBottomRef.current, programmaticScrollRef.current, msSinceUserScroll)) return;
    runProgrammaticScroll(el, () => { el.scrollTop = el.scrollHeight; });
  }, [blocks]);

  return (
    <div className="messages-wrap" ref={wrapRef}>
      <div className="messages">
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
        {promptLost && selectedWorker && (
          <div className="prompt-lost">
            <span className="prompt-lost-text">Prompt may have been lost — the agent never started.</span>
            <button
              className="prompt-lost-btn"
              onClick={() => { ui.addOptimisticUserMessage(selectedWorker.id, selectedWorker.prompt); live.sendToAgent(selectedWorker.id, selectedWorker.prompt); }}
            >
              Resend
            </button>
          </div>
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
    case "user":      return <MessageUser key={key} text={b.text} cwd={cwd} />;
    case "report":    return <MessageReport key={key} text={b.text} label={b.workerName || b.fromWorker || "worker"} direction="in" />;
    case "directive": return <MessageReport key={key} text={b.text} label={b.parentName || b.fromParent || "orchestrator"} direction="out" />;
    case "assistant": return <MessageAssistant key={key} text={b.text} />;
    case "thinking":  return <ThinkingLine key={key} text={b.text} ms={b.ms} />;
    case "toolGroup": {
      const groupKey = "g:" + (b.tools[0]?.id ?? b.ts);
      return <ToolGroup key={key} summary={b.summary} tools={b.tools}
        open={ui.expandedTools.has(groupKey)} onToggle={() => ui.toggleToolExpanded(groupKey)} />;
    }
    case "tool":      return <ToolItem key={key} tool={b.tool} standalone />;
    case "agentRun":  return <AgentBlock key={key} block={b} />;
    default: return null;
  }
}

