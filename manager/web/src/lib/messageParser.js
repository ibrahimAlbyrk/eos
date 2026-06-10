import { deriveToolLifecycle, parsePayload } from "./toolLifecycle.js";
import { parseSkillBody } from "./skillBody.js";

export { parsePayload };

// Tools that never merge into a toolGroup — always rendered as standalone blocks.
// (Agent is already standalone via its own agentRun block.)
export const STANDALONE_TOOLS = new Set([
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
  "mcp__orchestrator__notify_user",
  "mcp__orchestrator__message_worker",
  "mcp__orchestrator__spawn_worker",
  "mcp__orchestrator__kill_worker",
  "mcp__orchestrator__get_worker",
  "mcp__orchestrator__list_workers",
  "mcp__orchestrator__list_pending_permissions",
  "mcp__worker__send_message_to_parent",
]);

// conversation_cleared (/clear) wipes the visible history: everything before
// the last marker is dropped (display-only — the events store keeps it). The
// marker itself survives and renders as a divider.
export function applyClears(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "conversation_cleared") return events.slice(i);
  }
  return events;
}

// conversation_rewound (double-Esc rewind) hides the abandoned branch: every
// event from the rewound-to user message (it returns to the composer) up to
// the rewind marker is dropped, mirroring Claude Code's in-memory fork. The
// transcript and events store keep the branch — this is display-only.
export function applyRewinds(events, { bootPromptOffset = 0 } = {}) {
  let out = [];
  for (const ev of events) {
    if (ev.type !== "conversation_rewound") { out.push(ev); continue; }
    const cut = findRewindCut(out, parsePayload(ev.payload), bootPromptOffset);
    if (cut >= 0) out = out.slice(0, cut);
  }
  return out;
}

const normRewindText = (s) => (s ?? "").replace(/\s+/g, " ").trim();

function findRewindCut(events, payload, bootPromptOffset) {
  // Primary: last prompt event matching the rewound text (either-way prefix,
  // same tolerance as optimistic reconciliation — attachments append suffixes).
  const needles = [payload.text, payload.display].map(normRewindText).filter(Boolean);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "user_message" && e.type !== "orchestrator_message") continue;
    const t = normRewindText(parsePayload(e.payload).text);
    if (!t) continue;
    if (needles.some((n) => n === t || n.startsWith(t) || t.startsWith(n))) return i;
  }
  // Fallback by position: payload.index counts prompts on the transcript's
  // active branch; bootPromptOffset accounts for prompts with no event (an
  // orchestrator-dispatched worker's boot prompt renders from worker.prompt),
  // so the k-th prompt event sits at active-branch index k + offset.
  if (typeof payload.index === "number") {
    let count = bootPromptOffset;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type !== "user_message" && e.type !== "orchestrator_message") continue;
      if (count === payload.index) return i;
      count++;
    }
  }
  return -1;
}

export function buildBlocks(events) {
  const lc = deriveToolLifecycle(events);
  const toolUseIds = new Set();
  const agentSpans = new Map();
  // A Skill's injected SKILL.md body arrives as its own jsonl event, keyed to
  // the Skill tool_use id — collect it up front so the tool block can carry it.
  const skillBodyById = new Map();
  for (const ev of events) {
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "tool_use" && p.id) {
      toolUseIds.add(p.id);
      if (p.name === "Agent") {
        agentSpans.set(p.id, { startTs: ev.ts, endTs: Infinity, background: false });
      }
    } else if (p.kind === "skill_body" && p.toolUseId) {
      skillBodyById.set(p.toolUseId, parseSkillBody(p.text));
    }
  }
  for (const ev of events) {
    if (ev.type !== "jsonl") continue;
    const p = parsePayload(ev.payload);
    if (p.kind === "tool_result" && p.toolUseId && agentSpans.has(p.toolUseId)) {
      const isBackground = (p.text ?? "").includes("Async agent launched");
      if (isBackground) {
        agentSpans.get(p.toolUseId).background = true;
      } else {
        agentSpans.get(p.toolUseId).endTs = ev.ts;
      }
    }
  }

  const agentToolMap = new Map();
  const attachInnerTool = (agentId, tr, evIdx, ts) => {
    if (!agentToolMap.has(agentId)) agentToolMap.set(agentId, []);
    const turnExempt = agentSpans.get(agentId)?.background === true;
    agentToolMap.get(agentId).push({
      id: tr.toolUseId,
      name: tr.toolName ?? "unknown",
      input: tr.input ?? {},
      result: lc.resultOf(tr.toolUseId),
      done: lc.isDone(tr.toolUseId),
      running: !lc.isClosed(tr.toolUseId, evIdx, { turnExempt }),
      ts,
    });
  };
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== "tool_running") continue;
    const tr = parsePayload(ev.payload);
    if (!tr.toolUseId || toolUseIds.has(tr.toolUseId)) continue;
    if (tr.parentAgentToolUseId && agentSpans.has(tr.parentAgentToolUseId)) {
      attachInnerTool(tr.parentAgentToolUseId, tr, i, ev.ts);
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
    if (bestAgent) attachInnerTool(bestAgent, tr, i, ev.ts);
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

  const pushTool = (tool) => {
    if (STANDALONE_TOOLS.has(tool.name)) {
      flushTools();
      out.push({ kind: "tool", tool, ts: tool.ts });
    } else {
      pendingTools.push(tool);
    }
  };

  for (let evIdx = 0; evIdx < events.length; evIdx++) {
    const ev = events[evIdx];
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
        pushTool({
          id: tr.toolUseId,
          name: tr.toolName ?? "unknown",
          verb: verbFor(tr.toolName),
          input: tr.input ?? {},
          result: lc.resultOf(tr.toolUseId),
          running: !lc.isClosed(tr.toolUseId, evIdx),
          done: lc.isDone(tr.toolUseId),
          ts: ev.ts,
        });
      }
      continue;
    }
    if (ev.type === "lifecycle") {
      const payload = parsePayload(ev.payload);
      // Delivery pipeline gave up — the message never reached the agent.
      if (payload.phase === "delivery_failed") {
        flushTools();
        lastAsst = null;
        out.push({ kind: "deliveryFailed", text: payload.text ?? "", ts: ev.ts });
      }
      continue;
    }
    if (ev.type === "conversation_cleared") {
      flushTools();
      lastAsst = null;
      out.push({ kind: "cleared", ts: ev.ts });
      continue;
    }
    if (ev.type === "terminal") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "terminal",
        runId: payload.runId ?? null,
        command: payload.command ?? "",
        output: payload.output ?? "",
        exitCode: payload.exitCode ?? 0,
        note: payload.note ?? null,
        truncated: payload.truncated ?? false,
        done: true,
        ts: ev.ts,
      });
      continue;
    }
    if (ev.type === "git_push") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "push",
        outcome: payload.outcome ?? "failed",
        ok: payload.ok ?? false,
        message: payload.message ?? "",
        branch: payload.branch ?? null,
        ts: ev.ts,
      });
      continue;
    }
    if (ev.type === "worktree") {
      const payload = parsePayload(ev.payload);
      // Worker exited with uncommitted work — the worktree was preserved.
      if (payload.phase === "preserved") {
        flushTools();
        lastAsst = null;
        out.push({
          kind: "worktreePreserved",
          path: payload.path ?? "",
          branch: payload.branch ?? "",
          diffStat: payload.diffStat ?? "",
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
      if (!p.text?.trim()) continue; // signature-only blocks already persisted as text:""
      flushTools();
      lastAsst = null;
      out.push({ kind: "thinking", text: p.text, ts: ev.ts });
    } else if (p.kind === "tool_use") {
      lastAsst = null;
      if (p.name === "Agent") {
        flushTools();
        const result = lc.resultOf(p.id);
        const isBackground = result && (result.text ?? "").includes("Async agent launched");
        const cleanResult = isBackground ? null : (result?.text ?? null);
        const tools = agentToolMap.get(p.id) ?? [];
        const allToolsDone = tools.length > 0 && tools.every((t) => t.done);
        // Background agents outlive turns: only their inner tools completing or
        // the worker exiting can close them. Foreground agents close like any
        // tool — result, or a turn/exit barrier (kill mid-agent).
        const closed = isBackground
          ? allToolsDone || lc.exitAfter(evIdx)
          : lc.isClosed(p.id, evIdx);
        out.push({
          kind: "agentRun",
          toolUseId: p.id,
          description: p.input?.description || (p.input?.prompt ?? "").slice(0, 100) || "agent",
          prompt: p.input?.prompt ?? "",
          model: p.input?.model ?? p.parentModel ?? null,
          subagentType: p.input?.subagent_type ?? null,
          status: closed ? "completed" : "running",
          result: cleanResult,
          tools,
          ts: ev.ts,
        });
      } else {
        pushTool({
          id: p.id,
          name: p.name ?? "",
          verb: verbFor(p.name),
          input: p.input ?? {},
          result: lc.resultOf(p.id),
          running: !lc.isClosed(p.id, evIdx),
          done: lc.isDone(p.id),
          ts: ev.ts,
          ...(skillBodyById.has(p.id)
            ? { skillBody: skillBodyById.get(p.id).body, skillPath: skillBodyById.get(p.id).path }
            : {}),
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

const GIT_VERBS = {
  commit: "Committed",
  push: "Pushed",
  pull: "Pulled",
  merge: "Merged",
  rebase: "Rebased",
  fetch: "Fetched",
  clone: "Cloned",
  checkout: "Checked out",
  switch: "Switched to",
  stash: "Stashed",
  "cherry-pick": "Cherry-picked",
  revert: "Reverted",
  reset: "Reset",
  restore: "Restored",
  tag: "Tagged",
  add: "Staged",
  diff: "Viewed diff",
  apply: "Applied",
  am: "Applied",
};

// Matches `git [global flags] <subcommand> <rest until ; & |>` outside quoted strings.
const GIT_CMD_RE = /\bgit\s+(?:-[cC]\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*([a-z][\w-]*)([^;&|]*)/g;

export function gitActions(tool) {
  if (tool.name !== "Bash" || tool.result?.isError) return [];
  const cmd = (tool.input?.command ?? "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  const actions = [];
  GIT_CMD_RE.lastIndex = 0;
  let m;
  while ((m = GIT_CMD_RE.exec(cmd))) {
    const verb = GIT_VERBS[m[1]];
    if (!verb) continue;
    const detail = m[2]
      .replace(/--?[\w-]+(?:=\S+)?/g, "")
      .replace(/\S*[<>]\S*/g, "")
      .replace(/""/g, "")
      .trim()
      .slice(0, 60);
    actions.push({ sub: m[1], verb, detail });
  }
  if (actions.some((a) => a.sub === "commit")) {
    const shas = [...(tool.result?.text ?? "").matchAll(/\[[^\]\n]*\b([0-9a-f]{7,40})\]/g)].map((x) => x[1]);
    for (const a of actions) if (a.sub === "commit") a.shas = shas;
  }
  return actions;
}

export function gitVerbLabel(verb, n) {
  if (n === 1) return verb;
  if (verb === "Viewed diff") return `Viewed ${n} diffs`;
  return `${verb} ×${n}`;
}

export function buildSummary(tools) {
  let reads = 0;
  let edits = 0;
  let skills = 0;
  let notifies = 0;
  let shells = 0;
  let others = 0;
  const gitVerbs = [];
  const commitShas = [];
  for (const t of tools) {
    if (t.name === "Read") reads++;
    else if (t.verb === "edit") edits++;
    else if (t.name === "Skill") skills++;
    else if (t.name === "mcp__orchestrator__notify_user") notifies++;
    else if (t.name === "Bash") {
      const actions = gitActions(t);
      if (actions.length === 0) { shells++; continue; }
      for (const a of actions) {
        if (a.sub === "commit") commitShas.push(...(a.shas ?? []));
        const c = gitVerbs.find((x) => x.verb === a.verb);
        if (c) c.n++;
        else gitVerbs.push({ verb: a.verb, n: 1 });
      }
    }
    else others++;
  }
  const parts = [];
  if (reads > 0) parts.push(`Read ${reads} file${reads > 1 ? "s" : ""}`);
  if (edits > 0) parts.push(`Edited ${edits} file${edits > 1 ? "s" : ""}`);
  if (skills > 0) parts.push(`Used ${skills} skill${skills > 1 ? "s" : ""}`);
  if (notifies > 0) parts.push("Notified user");
  for (const { verb, n } of gitVerbs) {
    if (verb === "Committed" && commitShas.length > 0) parts.push(`Committed ${commitShas.join(", ")}`);
    else parts.push(gitVerbLabel(verb, n));
  }
  if (shells > 0) parts.push(`ran ${shells} shell command${shells > 1 ? "s" : ""}`);
  if (others > 0) parts.push(`used ${others} tool${others > 1 ? "s" : ""}`);
  return parts.join(", ");
}

export function verbFor(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bash")) return "bash";
  if (n.includes("edit") || n.includes("write")) return "edit";
  return "read";
}
