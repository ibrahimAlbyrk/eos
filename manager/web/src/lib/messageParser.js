export function buildBlocks(events) {
  const resultMap = new Map();
  const toolUseIds = new Set();
  for (const ev of events) {
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "tool_result" && p.toolUseId) {
      resultMap.set(p.toolUseId, { text: p.text ?? "", isError: !!p.isError });
    }
    if (p.kind === "tool_use" && p.id) {
      toolUseIds.add(p.id);
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
    if (ev.type === "worker_report") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "report",
        text: payload.text ?? "",
        fromWorker: payload.fromWorker ?? null,
        workerName: payload.workerName ?? null,
        ts: ev.ts,
      });
      continue;
    }
    if (ev.type === "orchestrator_message") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "directive",
        text: payload.text ?? "",
        fromParent: payload.fromParent ?? null,
        parentName: payload.parentName ?? null,
        ts: ev.ts,
      });
      continue;
    }
    if (ev.type === "tool_running") {
      const tr = parsePayload(ev.payload);
      if (tr.toolUseId && !toolUseIds.has(tr.toolUseId)) {
        lastAsst = null;
        pendingTools.push({
          id: tr.toolUseId,
          name: tr.toolName ?? "unknown",
          verb: verbFor(tr.toolName),
          input: tr.input ?? {},
          result: null,
          running: true,
          ts: ev.ts,
        });
      }
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
      if (p.name === "Agent") {
        flushTools();
        const result = resultMap.get(p.id);
        out.push({
          kind: "agentRun",
          toolUseId: p.id,
          description: p.input?.description || (p.input?.prompt ?? "").slice(0, 100) || "agent",
          model: p.input?.model ?? null,
          status: result ? "completed" : "running",
          result: result?.text ?? null,
          ts: ev.ts,
        });
      } else {
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
  }
  flushTools();
  return out;
}

export function buildSummary(tools) {
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

export function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === "string") {
    try { return JSON.parse(payload); } catch { return {}; }
  }
  return payload;
}

export function verbFor(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bash")) return "bash";
  if (n.includes("edit") || n.includes("write")) return "edit";
  return "read";
}
