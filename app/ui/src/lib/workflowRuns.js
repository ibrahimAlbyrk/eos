// A Claude Code Workflow run as the card and the side-panel tab show it — pure.
// Inputs: the parser's workflow block ({ tool, started, completed }), the
// store's entry ({ live, detail }) and the clock.

import { assignIdentities } from "./subagentIdentity.js";

const EMPTY = { phases: [], agents: [], logs: [] };

// --- what the call itself says ------------------------------------------------
// Display only: the script is never evaluated, just read for its meta literal.

const STRING = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
const unescape = (s) => s.replace(/\\(.)/g, "$1");
const field = (src, name) => {
  const m = new RegExp(`\\b${name}\\s*:\\s*${STRING}`).exec(src);
  return m ? unescape(m[2]) : null;
};
const metaOf = (script) => /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script ?? "")?.[1] ?? "";

// meta.name, a named workflow, or the script file's name.
export function workflowNameOf(input = {}) {
  if (typeof input.name === "string" && input.name) return input.name;
  const fromMeta = field(metaOf(input.script), "name");
  if (fromMeta) return fromMeta;
  const path = typeof input.scriptPath === "string" ? input.scriptPath : "";
  if (path) return path.slice(path.lastIndexOf("/") + 1).replace(/(-wf_[\w-]+)?\.[cm]?js$/, "");
  return "workflow";
}

export function workflowDescriptionOf(input = {}) {
  return field(metaOf(input.script), "description");
}

// meta.phases — so the rail shows what's still ahead before the run reaches it.
export function metaPhasesOf(input = {}) {
  const list = /\bphases\s*:\s*\[([\s\S]*?)\]/.exec(metaOf(input.script))?.[1] ?? "";
  const phases = [];
  for (const m of list.matchAll(/\{([^{}]*)\}/g)) {
    const title = field(m[1], "title");
    if (!title) continue;
    const detail = field(m[1], "detail");
    phases.push({ index: phases.length + 1, title, ...(detail ? { detail } : {}) });
  }
  return phases;
}

// --- the run --------------------------------------------------------------------

const TOOL_VERBS = {
  Read: "Reading", Grep: "Searching", Glob: "Finding", Bash: "Running", Edit: "Editing", MultiEdit: "Editing",
  Write: "Writing", NotebookEdit: "Editing", WebFetch: "Fetching", WebSearch: "Searching the web",
  Agent: "Delegating", Task: "Delegating", TodoWrite: "Planning", StructuredOutput: "Reporting",
};

const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";

// What an agent is doing now, or what it came to.
export function agentActivity(a) {
  switch (a.state) {
    case "queued": return "Waiting to start";
    case "running": {
      if (!a.lastToolName) return "Thinking…";
      const verb = TOOL_VERBS[a.lastToolName] ?? a.lastToolName;
      return a.lastToolSummary ? `${verb} ${a.lastToolSummary}` : verb;
    }
    case "error": return firstLine(a.error) || "Failed";
    case "cancelled": return "Stopped";
    default: return firstLine(a.resultPreview) || "Done";
  }
}

function agentElapsed(a, now) {
  if (a.state === "running") return a.startedAt ? Math.max(0, now - a.startedAt) : null;
  if (a.durationMs != null) return a.durationMs;
  return a.startedAt && a.lastProgressAt && a.state !== "queued" ? Math.max(0, a.lastProgressAt - a.startedAt) : null;
}

export function runStatusOf(block, entry) {
  if (block?.completed) return block.completed.status;
  const live = entry?.live;
  if (live && live.status !== "running") return live.status;
  if (entry?.detail) return entry.detail.status;
  if (live || block?.started) return "running";
  return "starting";
}

export const isRunActive = (status) => status === "running" || status === "starting";

function snapshotOf(status, block, entry) {
  const { live, detail } = entry ?? {};
  if (isRunActive(status)) return live?.snapshot ?? detail?.snapshot ?? EMPTY;
  // A finished run's detail carries what only its record knows (logs, details).
  if (detail && detail.status !== "running") return detail.snapshot;
  return block?.completed?.snapshot ?? live?.snapshot ?? detail?.snapshot ?? EMPTY;
}

function phaseState(c) {
  if (c.running + c.queued > 0) return "running";
  if (c.failed > 0) return "error";
  if (c.stopped > 0) return "stopped";
  if (c.total > 0) return "done";
  return "pending";
}

export function workflowRunModel(block, entry, now) {
  const tool = block?.tool ?? {};
  const input = tool.input ?? {};
  const { live, detail } = entry ?? {};
  const started = block?.started ?? null;
  const completed = block?.completed ?? null;
  const status = runStatusOf(block, entry);
  const active = isRunActive(status);
  const snap = snapshotOf(status, block, entry);
  const extra = detail?.snapshot ?? EMPTY;

  // Phases: the script's plan, then what the run and its record reported.
  const phaseMap = new Map();
  for (const list of [metaPhasesOf(input), extra.phases, snap.phases]) {
    for (const p of list) phaseMap.set(p.index, { ...phaseMap.get(p.index), ...p, detail: p.detail ?? phaseMap.get(p.index)?.detail });
  }

  const identities = assignIdentities(snap.agents.map((a) => a.agentId ?? `${tool.id}#${a.index}`));
  // An ended run has no live agents, whatever its last snapshot said (the
  // daemon settles them too — core's settleWorkflowSnapshot; this covers runs
  // recorded before it did, and a snapshot that reached us first).
  const settle = (a) => (active || (a.state !== "running" && a.state !== "queued") ? a
    : { ...a, state: status === "completed" ? "done" : "cancelled" });
  const agents = snap.agents.map(settle).map((a) => {
    const key = a.agentId ?? `${tool.id}#${a.index}`;
    return {
      ...a,
      key,
      identity: identities.get(key),
      glyphStatus: a.state === "running" ? "running" : a.state === "error" ? "failed" : a.state === "cancelled" ? "stopped" : "completed",
      activity: agentActivity(a),
      elapsedMs: agentElapsed(a, now),
    };
  });
  // Agents a script ran outside any phase() share one group up front.
  if (agents.some((a) => !a.phaseIndex)) phaseMap.set(0, { index: 0, title: "Agents" });

  const phases = [...phaseMap.values()].sort((a, b) => a.index - b.index).map((p) => {
    const list = agents.filter((a) => (a.phaseIndex ?? 0) === p.index);
    const count = (s) => list.filter((a) => a.state === s).length;
    const c = { total: list.length, running: count("running"), queued: count("queued"), done: count("done"), failed: count("error"), stopped: count("cancelled") };
    const state = phaseState(c);
    return { ...p, agents: list, counts: c, state, progress: c.total ? (c.done + c.failed + c.stopped) / c.total : 0 };
  });
  const current = phases.filter((p) => p.state === "running").at(-1) ?? null;

  const usage = completed?.usage ?? live?.usage ?? detail?.usage ?? null;
  const sum = (k) => agents.reduce((n, a) => n + (a[k] ?? 0), 0);
  const startedAt = detail?.startedAt ?? started?.ts ?? tool.ts ?? null;
  const endedAt = detail?.endedAt ?? completed?.ts ?? null;
  const elapsedMs = active
    ? (startedAt ? Math.max(0, now - startedAt) : null)
    : usage?.durationMs ?? (startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null);

  return {
    callId: tool.id,
    name: started?.name ?? detail?.name ?? workflowNameOf(input),
    description: started?.description ?? detail?.description ?? workflowDescriptionOf(input),
    status,
    active,
    elapsedMs,
    phases,
    currentPhase: current,
    agents,
    totals: {
      agents: agents.length,
      running: agents.filter((a) => a.state === "running").length,
      queued: agents.filter((a) => a.state === "queued").length,
      done: agents.filter((a) => a.state === "done").length,
      failed: agents.filter((a) => a.state === "error").length,
      stopped: agents.filter((a) => a.state === "cancelled").length,
      tokens: usage?.totalTokens ?? sum("tokens"),
      toolUses: usage?.toolUses ?? sum("toolCalls"),
    },
    logs: snap.logs.length ? snap.logs : extra.logs,
    summary: completed?.summary ?? detail?.summary ?? null,
    canStop: active && detail?.canStop === true,
  };
}
