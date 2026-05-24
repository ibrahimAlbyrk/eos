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
import { MessageUser } from "./MessageUser.jsx";
import { MessageAssistant } from "./MessageAssistant.jsx";
import { ToolGroup } from "./ToolGroup.jsx";
import { ToolItem } from "./ToolItem.jsx";
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

  // Activity anchor — sits below the most recent block. Two modes:
  //   busy=true  → animated spark + live ticking elapsed (how long the
  //                agent has been thinking since the user's message)
  //   busy=false → static spark, no text (just an anchor under the reply)
  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const lastBlock = blocks[blocks.length - 1];
  const agentBusy = selectedWorker && (selectedWorker.state === "SPAWNING" || selectedWorker.state === "WORKING");
  const isWaiting = !!(lastBlock && lastBlock.kind === "user" && agentBusy);
  const isAgentReply = lastBlock && (lastBlock.kind === "assistant" || lastBlock.kind === "toolGroup" || lastBlock.kind === "thinking");
  let lastUserTs = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "user") { lastUserTs = blocks[i].ts; break; }
  }
  const waitingElapsedMs = isWaiting && lastUserTs ? Math.max(0, live.now - lastUserTs) : 0;
  const showAnchor = isWaiting || isAgentReply;

  return (
    <div className="messages-wrap">
      <div className="messages">
        {blocks.map((b, i) => renderBlock(b, i))}
        {showAnchor && (
          <ProcessingLine
            busy={isWaiting}
            elapsed={isWaiting && lastUserTs && waitingElapsedMs >= 1000 ? fmtElapsedShort(waitingElapsedMs) : null}
          />
        )}
      </div>
    </div>
  );
}

function renderBlock(b, i) {
  switch (b.kind) {
    case "user":      return <MessageUser key={i} text={b.text} />;
    case "assistant": return <MessageAssistant key={i} text={b.text} />;
    case "thinking":  return <ThinkingLine key={i} text={b.text} ms={b.ms} />;
    case "toolGroup": return <ToolGroup key={i} summary={b.summary} tools={b.tools} />;
    case "tool":      return <ToolItem key={i} tool={b.tool} standalone />;
    default: return null;
  }
}

function buildBlocks(events) {
  const resultMap = new Map();
  for (const ev of events) {
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "tool_result" && p.toolUseId) {
      resultMap.set(p.toolUseId, { text: p.text ?? "", isError: !!p.isError });
    }
  }

  const out = [];
  let lastAsst = null;
  let pendingTools = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      out.push({ kind: "tool", tool: pendingTools[0], ts: pendingTools[0].ts });
    } else {
      out.push({ kind: "toolGroup", summary: buildSummary(pendingTools), tools: [...pendingTools], ts: pendingTools[0].ts });
    }
    pendingTools = [];
  };

  for (const ev of events) {
    if (ev.type === "user_message") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({ kind: "user", text: payload.text ?? "", ts: ev.ts });
      continue;
    }
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);

    if (p.kind === "assistant_text") {
      flushTools();
      if (lastAsst && out[out.length - 1] === lastAsst) {
        lastAsst.text += "\n" + (p.text ?? "");
      } else {
        lastAsst = { kind: "assistant", text: p.text ?? "", ts: ev.ts };
        out.push(lastAsst);
      }
    } else if (p.kind === "thinking") {
      flushTools();
      lastAsst = null;
      out.push({ kind: "thinking", text: p.text ?? "", ms: p.ms, ts: ev.ts });
    } else if (p.kind === "tool_use") {
      lastAsst = null;
      pendingTools.push({
        id: p.id,
        name: p.name ?? "",
        verb: verbFor(p.name),
        input: p.input ?? {},
        result: resultMap.get(p.id) ?? null,
        ts: ev.ts,
      });
    }
  }
  flushTools();
  return out;
}

function buildSummary(tools) {
  let reads = 0;
  let edits = 0;
  let others = 0;
  for (const t of tools) {
    if (t.name === "Read") reads++;
    else if (t.verb === "edit") edits++;
    else others++;
  }
  const parts = [];
  if (reads > 0) parts.push(`Read ${reads} file${reads > 1 ? "s" : ""}`);
  if (edits > 0) parts.push(`Edited ${edits} file${edits > 1 ? "s" : ""}`);
  if (others > 0) parts.push(`used ${others} tool${others > 1 ? "s" : ""}`);
  return parts.join(", ");
}

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === "string") {
    try { return JSON.parse(payload); } catch { return {}; }
  }
  return payload;
}

function verbFor(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bash")) return "bash";
  if (n.includes("edit") || n.includes("write")) return "edit";
  return "read";
}
