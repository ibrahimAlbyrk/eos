import { deriveToolLifecycle, parsePayload } from "./toolLifecycle.js";
import { parseSkillBody } from "./skillBody.js";
import { isWorkerToolName, WORKER_TOOL_SPECS } from "./workerTools.js";

export { parsePayload };

// Typed provider-error codes → human English with remediation. The keys MUST match
// the STRING contract produced by the in-process model clients
// (infra/src/backends/{Anthropic,OpenAI}ModelClient.ts); any other reason (raw
// `HTTP <status>: …`, stream stalls) falls back to the raw string.
const PROVIDER_ERROR_MESSAGES = {
  insufficient_credits: "Provider API credits exhausted — add credits in your provider console.",
  auth_invalid: "Provider API key invalid or expired — check the key in your provider settings.",
};
export function providerErrorMessage(reason) {
  return PROVIDER_ERROR_MESSAGES[reason] || reason || "The model turn failed.";
}

// Tools that never merge into a toolGroup — always rendered as standalone blocks.
// "Agent" is here for the live hook-only window: the transcript tool_use (which
// renders the agentRun block) flushes at step boundaries, so mid-turn the Agent
// only exists as a tool_running event and would otherwise group as generic.
export const STANDALONE_TOOLS = new Set([
  "Agent",
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
  "mcp__orchestrator__notify_user",
  "mcp__worker__send_message_to_parent",
]);

// A tool_use that runs a subagent: the lane-neutral `spawnsSubagent` marker (every
// backend stamps it), OR name === "Agent" for events persisted before the marker
// existed. Drives agentRun folding + inner-tool attribution.
const isSubagentToolUse = (p) => p.spawnsSubagent === true || p.name === "Agent";

// Grouping lanes: a consecutive run of same-lane tools collapses into one
// toolGroup; a lane change flushes the run. null = standalone, never groups.
const laneOf = (name) =>
  STANDALONE_TOOLS.has(name) ? null
  : isWorkerToolName(name) ? "worker"
  : "generic";

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

// message_recalled (interrupt-before-response, SDK lane) hides the just-sent
// user message the agent never answered: the matching user_message is dropped
// (its text returns to the composer) and the marker itself renders nothing.
// Matched by the recalled event-row id, falling back to clientMsgId. Display-only
// — the events store keeps both rows (mirrors applyRewinds/applyClears).
export function applyRecalls(events) {
  const rowIds = new Set();
  const clientMsgIds = new Set();
  for (const ev of events) {
    if (ev.type !== "message_recalled") continue;
    const p = parsePayload(ev.payload);
    if (typeof p.recalledRowId === "number") rowIds.add(p.recalledRowId);
    if (p.clientMsgId) clientMsgIds.add(p.clientMsgId);
  }
  if (rowIds.size === 0 && clientMsgIds.size === 0) return events;
  return events.filter((ev) => {
    if (ev.type === "message_recalled") return false; // the marker renders nothing
    if (ev.type !== "user_message") return true;
    if (rowIds.has(ev.id)) return false;
    const ids = parsePayload(ev.payload).clientMsgIds ?? [];
    return !ids.some((c) => clientMsgIds.has(c));
  });
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

// Stable chronological order for the rendered block list. Block ts lives in
// the transcript-CREATION clock domain wherever possible (payload.tsTranscript
// for jsonl blocks, payload.anchorTs for sighting-anchored messages): event-row
// ts is daemon RECEIPT time, and the CLI batch-flushes transcript lines
// 150ms–2.5s after creation, so receipt-domain comparisons misplace anything
// emitted in that window (e.g. a drained queue message vs the previous turn's
// trailing output). Optimistic bubbles (send time) share the same wall clock.
// Same-ts runs keep their relative order (Array.prototype.sort is stable).
export function sortBlocksByTs(blocks) {
  return blocks.sort((a, b) => {
    const d = (a.ts ?? 0) - (b.ts ?? 0);
    return Number.isNaN(d) ? 0 : d;
  });
}

// One content decoder. claude-cli (after the canonical persistence switch) and the
// in-process / claude-sdk lanes all persist canonical agent_event rows; expand each
// into the legacy content shapes buildBlocks already understands (jsonl +
// tool_running/tool_done + turn/exit barriers) so the entire rich pipeline below —
// subagent agentSpans, skill bodies, tool lifecycle, grouping lanes — is reused
// unchanged. Non-content rows (synthesized user_message / worker_report / peer_* /
// terminal / git / lifecycle / state …) pass through untouched. blockId is carried
// on text/reasoning so the live-streaming → durable handoff still reconciles.
function normalizeEvents(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type !== "agent_event") { out.push(ev); continue; }
    const e = parsePayload(ev.payload);
    const ts = ev.ts;
    if (e?.type === "message" && e.role === "assistant") {
      for (const b of e.blocks ?? []) {
        if (b.type === "text") out.push({ type: "jsonl", ts, payload: { kind: "assistant_text", text: b.text ?? "", blockId: b.blockId } });
        else if (b.type === "reasoning") out.push({ type: "jsonl", ts, payload: { kind: "thinking", text: b.text ?? "", blockId: b.blockId } });
        else if (b.type === "tool_call") out.push({ type: "jsonl", ts, payload: { kind: "tool_use", id: b.callId, name: b.name ?? "", input: b.input ?? {}, ...(b.spawnsSubagent ? { spawnsSubagent: true } : {}) } });
        else if (b.type === "tool_result") out.push({ type: "jsonl", ts, payload: { kind: "tool_result", toolUseId: b.callId, isError: !!b.isError, text: b.content ?? "", patch: b.patch } });
        else if (b.type === "skill") out.push({ type: "jsonl", ts, payload: { kind: "skill_body", toolUseId: b.callId, text: b.text ?? "" } });
      }
    } else if (e?.type === "message" && e.role === "tool") {
      for (const b of e.blocks ?? []) {
        if (b.type === "tool_result") out.push({ type: "jsonl", ts, payload: { kind: "tool_result", toolUseId: b.callId, isError: !!b.isError, text: b.content ?? "", patch: b.patch } });
      }
    } else if (e?.type === "activity") {
      if (e.kind === "tool_started") out.push({ type: "tool_running", ts, payload: { toolName: e.toolName, toolUseId: e.callId, input: e.input ?? {}, parentAgentToolUseId: e.parentCallId ?? undefined } });
      else if (e.kind === "tool_finished") out.push({ type: "tool_done", ts, payload: { toolName: e.toolName, toolUseId: e.callId, result: e.result ?? "", isError: !!e.isError } });
      // alive → drop (heartbeat: no render, no lifecycle effect)
    } else if (e?.type === "turn" && e.phase !== "started") {
      out.push({ type: "hook", ts, payload: { event: "Stop" } }); // turn end → tool-lifecycle turn barrier; no render
      // A turn that ended in error (provider billing/auth failure, stream stall, …)
      // ALSO surfaces a renderable error block — without it the worker just goes idle
      // with no feedback. The Stop barrier above still closes open tools.
      if (e.phase === "error") out.push({ type: "turn_error", ts, payload: { reason: e.reason ?? "" } });
    } else if (e?.type === "session" && e.phase === "ended") {
      out.push({ type: "exit", ts, payload: {} }); // exit barrier — closes every open tool
    }
    // role:"user" → rendered via the synthesized user_message event (no double);
    // delta/usage/permission_request/question_request: no content/lifecycle here.
  }
  return out;
}

export function buildBlocks(rawEvents) {
  // Expand canonical agent_event rows into the legacy content shapes, then run the
  // one rich decoder over the normalized stream (see normalizeEvents).
  const events = normalizeEvents(rawEvents);
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
      if (isSubagentToolUse(p)) {
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
  let pendingLane = null;
  // The most recent incoming peer question — respond_to_peer (whose input has
  // no asker) is linked to it so its header can name who it answered.
  let lastPeerReq = null;
  // The ask_peer tool awaiting its peer_consult link — that event (carrying the
  // peer's durable name) lands just after the tool starts, so we attach it back
  // onto the tool. Mirrors lastPeerReq for the asker side.
  let lastAskPeer = null;

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      out.push({ kind: "tool", tool: pendingTools[0], ts: pendingTools[0].ts });
    } else {
      out.push({
        kind: "toolGroup",
        lane: pendingLane,
        summary: LANES[pendingLane].summarize(pendingTools),
        tools: [...pendingTools],
        ts: pendingTools[0].ts,
      });
    }
    pendingTools = [];
    pendingLane = null;
  };

  const pushTool = (tool) => {
    if (tool.name === "mcp__worker__respond_to_peer" && !tool.peerTo && lastPeerReq) tool.peerTo = lastPeerReq;
    if (tool.name === "mcp__worker__ask_peer") lastAskPeer = tool;
    const lane = laneOf(tool.name);
    if (lane === null) {
      flushTools();
      out.push({ kind: "tool", tool, ts: tool.ts });
      return;
    }
    if (pendingTools.length > 0 && lane !== pendingLane) flushTools();
    pendingLane = lane;
    pendingTools.push(tool);
  };

  for (let evIdx = 0; evIdx < events.length; evIdx++) {
    const ev = events[evIdx];
    if (ev.type === "user_message") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      // anchorTs (the consuming transcript entry's creation time) is the true
      // conversation position; sentAt (dispatch time) covers emissions with no
      // sighting (unverified delivery, flush); event receipt ts is last resort.
      out.push({ kind: "user", text: payload.text ?? "", ts: payload.anchorTs ?? payload.sentAt ?? ev.ts });
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
        ts: payload.anchorTs ?? payload.sentAt ?? ev.ts,
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
        ts: payload.anchorTs ?? payload.sentAt ?? ev.ts,
      });
      continue;
    }
    if (ev.type === "loop_continuation") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "loop",
        text: payload.text ?? "",
        ts: payload.anchorTs ?? payload.sentAt ?? ev.ts,
      });
      continue;
    }
    if (ev.type === "loop_check") {
      // Durable per-attempt goal-check verdict (LoopCheckEventSchema). The
      // chronological record renders inline; the LoopStatus card also aggregates
      // these into an attempt history off the same blocks.
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "loopCheck",
        attempt: payload.attempt ?? null,
        maxAttempts: payload.maxAttempts ?? null,
        strategy: payload.strategy ?? null,
        met: payload.met ?? false,
        outcome: payload.outcome ?? null,
        reason: payload.reason ?? "",
        ts: ev.ts,
      });
      continue;
    }
    if (ev.type === "peer_request") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      lastPeerReq = { id: payload.fromWorker ?? null, name: payload.fromName ?? null };
      out.push({
        kind: "peer-request",
        text: payload.text ?? "",
        fromWorker: payload.fromWorker ?? null,
        fromName: payload.fromName ?? null,
        ts: payload.anchorTs ?? payload.sentAt ?? ev.ts,
      });
      continue;
    }
    if (ev.type === "peer_consult") {
      // Asker-side consult marker — link the consulted peer's durable name onto
      // the ask_peer tool that triggered it (its tool_running precedes this), so
      // the header keeps the name after the peer is killed. Transparent to the
      // tool stream: no flush, no timeline item (the ask_peer tool renders it).
      const payload = parsePayload(ev.payload);
      if (
        lastAskPeer &&
        !lastAskPeer.peerTo &&
        (lastAskPeer.input?.peerId === payload.toWorker ||
          (payload.toName && lastAskPeer.input?.peerName === payload.toName))
      ) {
        lastAskPeer.peerTo = { id: payload.toWorker ?? null, name: payload.toName ?? null };
      }
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
    if (ev.type === "turn_error") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({ kind: "turnError", reason: payload.reason ?? "", message: providerErrorMessage(payload.reason ?? ""), ts: ev.ts });
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
    if (ev.type === "git_pull") {
      flushTools();
      lastAsst = null;
      const payload = parsePayload(ev.payload);
      out.push({
        kind: "pull",
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
        lastAsst = { kind: "assistant", text: p.text ?? "", ts: p.tsTranscript ?? ev.ts, ...(p.blockId ? { blockId: p.blockId } : {}) };
        out.push(lastAsst);
      }
    } else if (p.kind === "thinking") {
      if (!p.text?.trim()) continue; // signature-only blocks already persisted as text:""
      flushTools();
      lastAsst = null;
      out.push({ kind: "thinking", text: p.text, ts: p.tsTranscript ?? ev.ts, ...(p.blockId ? { blockId: p.blockId } : {}) });
    } else if (p.kind === "tool_use") {
      lastAsst = null;
      if (isSubagentToolUse(p)) {
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
          background: isBackground,
          result: cleanResult,
          tools,
          ts: p.tsTranscript ?? ev.ts,
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
          ts: p.tsTranscript ?? ev.ts,
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
  let webSearches = 0;
  let webFetches = 0;
  let shells = 0;
  let others = 0;
  const gitVerbs = [];
  const commitShas = [];
  for (const t of tools) {
    if (t.name === "Read") reads++;
    else if (t.verb === "edit") edits++;
    else if (t.name === "Skill") skills++;
    else if (t.name === "WebSearch") webSearches++;
    else if (t.name === "WebFetch") webFetches++;
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
  if (webSearches > 0) parts.push(`Searched the web${webSearches > 1 ? ` ×${webSearches}` : ""}`);
  if (webFetches > 0) parts.push(`Fetched ${webFetches} page${webFetches > 1 ? "s" : ""}`);
  if (notifies > 0) parts.push("Notified user");
  for (const { verb, n } of gitVerbs) {
    if (verb === "Committed" && commitShas.length > 0) parts.push(`Committed ${commitShas.join(", ")}`);
    else parts.push(gitVerbLabel(verb, n));
  }
  if (shells > 0) parts.push(`ran ${shells} shell command${shells > 1 ? "s" : ""}`);
  if (others > 0) parts.push(`used ${others} tool${others > 1 ? "s" : ""}`);
  return parts.join(", ");
}

// Per-tool counts in first-appearance order; only the first part keeps its
// capitalized verb ("Spawned 2 workers, killed 1 worker").
export function buildWorkerSummary(tools) {
  const counts = new Map();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const parts = [];
  for (const [name, n] of counts) {
    const phrase = WORKER_TOOL_SPECS[name].summary(n);
    parts.push(parts.length === 0 ? phrase : phrase[0].toLowerCase() + phrase.slice(1));
  }
  return parts.join(", ");
}

const LANES = {
  generic: { summarize: buildSummary },
  worker: { summarize: buildWorkerSummary },
};

export function verbFor(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("bash")) return "bash";
  if (n.includes("edit") || n.includes("write")) return "edit";
  return "read";
}
