export function buildBlocks(events) {
  const resultMap = new Map();
  const toolUseIds = new Set();
  const agentSpans = new Map();
  for (const ev of events) {
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "tool_result" && p.toolUseId) {
      resultMap.set(p.toolUseId, { text: p.text ?? "", isError: !!p.isError });
    }
    if (p.kind === "tool_use" && p.id) {
      toolUseIds.add(p.id);
      if (p.name === "Agent") {
        agentSpans.set(p.id, { startTs: ev.ts, endTs: Infinity });
      }
    }
  }
  for (const ev of events) {
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "tool_result" && p.toolUseId && agentSpans.has(p.toolUseId)) {
      const isBackground = (p.text ?? "").includes("Async agent launched");
      if (!isBackground) {
        agentSpans.get(p.toolUseId).endTs = ev.ts;
      }
    }
  }

  const toolDoneSet = new Set();
  const toolDoneMap = new Map();
  for (const ev of events) {
    if (ev.type !== "tool_done") continue;
    const td = parsePayload(ev.payload);
    if (td.toolUseId) {
      toolDoneSet.add(td.toolUseId);
      const text = td.result ?? "";
      if (text) toolDoneMap.set(td.toolUseId, { text, isError: false });
    }
  }

  const agentToolMap = new Map();
  for (const ev of events) {
    if (ev.type !== "tool_running") continue;
    const tr = parsePayload(ev.payload);
    if (!tr.toolUseId || toolUseIds.has(tr.toolUseId)) continue;
    if (tr.parentAgentToolUseId && agentSpans.has(tr.parentAgentToolUseId)) {
      const agentId = tr.parentAgentToolUseId;
      if (!agentToolMap.has(agentId)) agentToolMap.set(agentId, []);
      agentToolMap.get(agentId).push({
        id: tr.toolUseId,
        name: tr.toolName ?? "unknown",
        input: tr.input ?? {},
        result: toolDoneMap.get(tr.toolUseId) ?? null,
        done: toolDoneSet.has(tr.toolUseId),
        ts: ev.ts,
      });
      continue;
    }
    let bestAgent = null;
    let bestDist = Infinity;
    for (const [agentId, span] of agentSpans) {
      if (ev.ts >= span.startTs && ev.ts <= span.endTs) {
        bestAgent = agentId;
        break;
      }
      if (ev.ts > span.startTs && (ev.ts - span.startTs) < bestDist) {
        bestDist = ev.ts - span.startTs;
        bestAgent = agentId;
      }
    }
    if (bestAgent) {
      if (!agentToolMap.has(bestAgent)) agentToolMap.set(bestAgent, []);
      agentToolMap.get(bestAgent).push({
        id: tr.toolUseId,
        name: tr.toolName ?? "unknown",
        input: tr.input ?? {},
        result: toolDoneMap.get(tr.toolUseId) ?? null,
        done: toolDoneSet.has(tr.toolUseId),
        ts: ev.ts,
      });
    }
  }

  const attributedToolIds = new Set();
  for (const tools of agentToolMap.values()) {
    for (const t of tools) attributedToolIds.add(t.id);
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
      if (tr.toolUseId && !toolUseIds.has(tr.toolUseId) && !attributedToolIds.has(tr.toolUseId)) {
        lastAsst = null;
        const done = toolDoneSet.has(tr.toolUseId);
        pendingTools.push({
          id: tr.toolUseId,
          name: tr.toolName ?? "unknown",
          verb: verbFor(tr.toolName),
          input: tr.input ?? {},
          result: toolDoneMap.get(tr.toolUseId) ?? null,
          running: !done,
          done,
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
        const isBackground = result && (result.text ?? "").includes("Async agent launched");
        const cleanResult = isBackground ? null : (result?.text ?? null);
        const tools = agentToolMap.get(p.id) ?? [];
        const allToolsDone = tools.length > 0 && tools.every((t) => t.done);
        const bgDone = isBackground && allToolsDone;
        out.push({
          kind: "agentRun",
          toolUseId: p.id,
          description: p.input?.description || (p.input?.prompt ?? "").slice(0, 100) || "agent",
          prompt: p.input?.prompt ?? "",
          model: p.input?.model ?? p.parentModel ?? null,
          subagentType: p.input?.subagent_type ?? null,
          status: bgDone ? "completed" : (isBackground ? "running" : (result ? "completed" : "running")),
          result: cleanResult,
          tools,
          ts: ev.ts,
        });
      } else {
        pendingTools.push({
          id: p.id,
          name: p.name ?? "",
          verb: verbFor(p.name),
          input: p.input ?? {},
          result: resultMap.get(p.id) ?? toolDoneMap.get(p.id) ?? null,
          done: toolDoneSet.has(p.id),
          ts: ev.ts,
        });
      }
    }
  }
  flushTools();
  attachAskUserAnswers(out);
  return out;
}

function attachAskUserAnswers(blocks) {
  const removeIndices = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const tool = b.kind === "tool" ? b.tool : null;
    if (!tool || tool.name !== "AskUserQuestion") continue;
    for (let j = i + 1; j < blocks.length && j <= i + 3; j++) {
      if (blocks[j].kind === "user" && blocks[j].text?.startsWith("My answers to your questions:")) {
        tool.result = { text: blocks[j].text, isError: false };
        tool.running = false;
        tool.done = true;
        removeIndices.add(j);
        break;
      }
    }
  }
  if (removeIndices.size > 0) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (removeIndices.has(i)) blocks.splice(i, 1);
    }
  }
}

export function buildSummary(tools) {
  let reads = 0;
  let edits = 0;
  let skills = 0;
  let notifies = 0;
  let others = 0;
  for (const t of tools) {
    if (t.name === "Read") reads++;
    else if (t.verb === "edit") edits++;
    else if (t.name === "Skill") skills++;
    else if (t.name === "mcp__orchestrator__notify_user") notifies++;
    else others++;
  }
  const parts = [];
  if (reads > 0) parts.push(`Read ${reads} file${reads > 1 ? "s" : ""}`);
  if (edits > 0) parts.push(`Edited ${edits} file${edits > 1 ? "s" : ""}`);
  if (skills > 0) parts.push(`Used ${skills} skill${skills > 1 ? "s" : ""}`);
  if (notifies > 0) parts.push("Notified user");
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
