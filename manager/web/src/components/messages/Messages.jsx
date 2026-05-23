// Messages — renders the transcript for the selected agent. Pulls events
// for the selection via /workers/:id/events and maps each event type to a
// renderable block.
//
// This is the initial render layer; refinement (tool-group collapse, file
// chips, table rendering) lives in dedicated sub-components.

import { useEffect, useMemo, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { MessageUser } from "./MessageUser.jsx";
import { MessageAssistant } from "./MessageAssistant.jsx";
import { ToolGroup } from "./ToolGroup.jsx";
import { ThinkingLine } from "./ThinkingLine.jsx";

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
      base.push({ kind: "user", text: m.text, optimistic: true });
    }
    return base;
  }, [events, ui.optimisticMsgs, ui.selectedId]);

  return (
    <div className="messages-wrap">
      <div className="messages">
        {blocks.map((b, i) => renderBlock(b, i))}
      </div>
    </div>
  );
}

function renderBlock(b, i) {
  switch (b.kind) {
    case "user":      return <MessageUser key={i} text={b.text} />;
    case "assistant": return <MessageAssistant key={i} text={b.text} />;
    case "thinking":  return <ThinkingLine key={i} text={b.text} ms={b.ms} />;
    case "toolGroup": return <ToolGroup key={i} verb={b.verb} title={b.title} subtools={b.subtools} panel={b.panel} />;
    default: return null;
  }
}

// Convert event list to renderable blocks. Group consecutive tool_use events
// of the same verb into a toolGroup. Coalesce adjacent assistant_text.
function buildBlocks(events) {
  const out = [];
  let lastAsst = null;
  for (const ev of events) {
    if (ev.type === "user_message") {
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({ kind: "user", text: payload.text ?? "" });
      continue;
    }
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "assistant_text") {
      if (lastAsst && out[out.length - 1] === lastAsst) {
        lastAsst.text += "\n" + (p.text ?? "");
      } else {
        lastAsst = { kind: "assistant", text: p.text ?? "" };
        out.push(lastAsst);
      }
    } else if (p.kind === "thinking") {
      lastAsst = null;
      out.push({ kind: "thinking", text: p.text ?? "", ms: p.ms });
    } else if (p.kind === "tool_use") {
      lastAsst = null;
      out.push({ kind: "toolGroup", verb: verbFor(p.name), title: titleFor(p), subtools: [{ name: p.name, file: fileFor(p) }] });
    }
  }
  return out;
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

function titleFor(p) {
  if (p.name === "Bash") return `Ran ${(p.input?.command ?? "").slice(0, 80)}`;
  return `${p.name}${p.input?.file_path ? " · " + shortPath(p.input.file_path) : ""}`;
}

function fileFor(p) {
  return p.input?.file_path || p.input?.command || "";
}

function shortPath(p) {
  if (!p) return "";
  return p.split("/").slice(-2).join("/");
}
