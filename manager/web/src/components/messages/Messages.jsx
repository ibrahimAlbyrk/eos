// Messages — renders the transcript for the selected agent. Pulls events
// for the selection via /workers/:id/events and maps each event type to a
// renderable block.
//
// This is the initial render layer; refinement (tool-group collapse, file
// chips, table rendering) lives in dedicated sub-components.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { fmtElapsedShort } from "../../lib/format.js";
import { buildBlocks, parsePayload } from "../../lib/messageParser.js";
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
const SCROLL_THRESHOLD = 2;
const BUTTON_THRESHOLD = 300;

export function Messages({ live }) {
  const ui = useUi();
  const [events, setEvents] = useState([]);
  const wrapRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottomRef = useRef(true);
  const initialScrollDone = useRef(false);

  const checkNearBottom = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const overflows = el.scrollHeight > el.clientHeight;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = dist < SCROLL_THRESHOLD;
    setShowScrollBtn(overflows && dist >= BUTTON_THRESHOLD);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => el.removeEventListener("scroll", checkNearBottom);
  }, [checkNearBottom]);

  const scrollToBottom = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const fetchRef = useRef(null);

  useEffect(() => { initialScrollDone.current = false; }, [ui.selectedId]);

  useEffect(() => {
    if (!ui.selectedId || ui.drafts.has(ui.selectedId)) { setEvents([]); fetchRef.current = null; return; }
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
  }, [ui.selectedId, live.workers.length, ui.drafts, ui.reconcileOptimisticMessages]);

  useEffect(() => {
    if (live.eventSignal.workerId !== ui.selectedId) return;
    fetchRef.current?.();
  }, [live.eventSignal.tick]);

  const pendingQuestion = useMemo(() => {
    const running = new Map();
    const done = new Set();
    let hasAnswerMessage = false;
    for (const ev of events) {
      if (ev.type === "tool_running") {
        const p = parsePayload(ev.payload);
        if (p.toolName === "AskUserQuestion" && p.toolUseId)
          running.set(p.toolUseId, { input: p.input, ts: ev.ts });
      }
      if (ev.type === "tool_done") {
        const p = parsePayload(ev.payload);
        if (p.toolUseId) done.add(p.toolUseId);
      }
      if (ev.type === "user_message") {
        const p = parsePayload(ev.payload);
        if (p.text?.startsWith("My answers to your questions:")) hasAnswerMessage = true;
      }
    }
    if (hasAnswerMessage) return null;
    for (const [id, { input }] of running) {
      if (!done.has(id) && Array.isArray(input?.questions) && input.questions.length > 0)
        return { toolUseId: id, questions: input.questions };
    }
    return null;
  }, [events]);

  useEffect(() => {
    ui.setPendingQuestion(pendingQuestion);
  }, [pendingQuestion]);

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
    if (isNearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
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
          const block = renderBlock(b, i, selectedWorker?.cwd);
          if (isLast && interrupted && b.kind !== "user") {
            return <div key={i} className="msg-interrupted-wrap">{block}</div>;
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

function renderBlock(b, i, cwd) {
  switch (b.kind) {
    case "user":      return <MessageUser key={i} text={b.text} cwd={cwd} />;
    case "report":    return <MessageReport key={i} text={b.text} label={b.workerName || b.fromWorker || "worker"} direction="in" />;
    case "directive": return <MessageReport key={i} text={b.text} label={b.parentName || b.fromParent || "orchestrator"} direction="out" />;
    case "assistant": return <MessageAssistant key={i} text={b.text} />;
    case "thinking":  return <ThinkingLine key={i} text={b.text} ms={b.ms} />;
    case "toolGroup": return <ToolGroup key={i} summary={b.summary} tools={b.tools} />;
    case "tool":      return <ToolItem key={i} tool={b.tool} standalone />;
    case "agentRun":  return <AgentBlock key={i} block={b} />;
    default: return null;
  }
}

