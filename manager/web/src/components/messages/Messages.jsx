// Messages — renders the transcript for the selected agent. Pulls events
// for the selection via /workers/:id/events and maps each event type to a
// renderable block.
//
// This is the initial render layer; refinement (tool-group collapse, file
// chips, table rendering) lives in dedicated sub-components.

import { useEffect, useMemo, useState } from "react";
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

const POLL_MS = 1000;

export function Messages({ live }) {
  const ui = useUi();
  const [events, setEvents] = useState([]);

  useEffect(() => {
    // Drafts don't have a daemon-side worker row — skip the /events poll.
    if (!ui.selectedId || ui.drafts.has(ui.selectedId)) { setEvents([]); return; }
    const ac = new AbortController();
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const rows = await api.getWorkerEvents(ui.selectedId, { limit: 500, order: "asc", signal: ac.signal });
        if (!cancelled && Array.isArray(rows)) {
          setEvents(rows);
          // Reconcile optimistic messages — drop the ones the server has
          // now persisted as user_message rows.
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
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(t); ac.abort(); };
  }, [ui.selectedId, live.workers.length, ui.drafts, ui.reconcileOptimisticMessages]);

  const blocks = useMemo(() => {
    const base = buildBlocks(events);
    const opt = ui.optimisticMsgs.get(ui.selectedId) ?? [];
    for (const m of opt) {
      base.push({ kind: "user", text: m.text, ts: m.ts, optimistic: true });
    }
    return base;
  }, [events, ui.optimisticMsgs, ui.selectedId]);

  // Activity anchor — sits below the most recent block.
  //   Agent is busy (SPAWNING/WORKING) → animated spark (+ elapsed if last
  //   block is a user message, so the timer counts from when user sent it)
  //   Agent is idle and last block is from agent → static spark (anchor)
  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const lastBlock = blocks[blocks.length - 1];
  const agentBusy = selectedWorker && (selectedWorker.state === "SPAWNING" || selectedWorker.state === "WORKING");
  const lastIsUser = !!(lastBlock && lastBlock.kind === "user");
  const isAgentReply = lastBlock && (lastBlock.kind === "assistant" || lastBlock.kind === "toolGroup" || lastBlock.kind === "thinking" || lastBlock.kind === "agentRun");
  let lastUserTs = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "user") { lastUserTs = blocks[i].ts; break; }
  }
  const waitingElapsedMs = agentBusy && lastIsUser && lastUserTs ? Math.max(0, live.now - lastUserTs) : 0;
  const showAnchor = (agentBusy && blocks.length > 0) || isAgentReply;

  return (
    <div className="messages-wrap">
      <div className="messages">
        {blocks.map((b, i) => renderBlock(b, i))}
        {showAnchor && (
          <ProcessingLine
            busy={!!agentBusy}
            elapsed={agentBusy && lastIsUser && lastUserTs && waitingElapsedMs >= 1000 ? fmtElapsedShort(waitingElapsedMs) : null}
          />
        )}
      </div>
    </div>
  );
}

function renderBlock(b, i) {
  switch (b.kind) {
    case "user":      return <MessageUser key={i} text={b.text} />;
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

