// Pure formatters used across the UI.

export function fmtCost(n) {
  return "$" + (n || 0).toFixed(n >= 1 ? 2 : 3);
}

export function fmtElapsed(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function modelShort(model) {
  if (!model) return "—";
  return String(model).replace(/^claude-/, "");
}

export function ctxPct(agent) {
  const used = (agent.tokens?.in || 0) + (agent.tokens?.out || 0);
  const budget = agent.tokens?.budget || 200000;
  return Math.min(100, Math.round((used / budget) * 100));
}

export function toolIcon(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("read")) return "read";
  if (n.includes("edit") || n.includes("write")) return "edit";
  if (n.includes("bash")) return "terminal";
  if (n.includes("grep")) return "grep";
  if (n.includes("fetch") || n.includes("web")) return "globe";
  if (n.includes("spawn")) return "spawn";
  return "tool";
}

// Reads Date.now() at call time so the App's elapsedTickMs interval keeps
// counters smooth without waiting on the next poll.
export function liveElapsed(agent) {
  if (!agent || !agent.startedTs) return "—";
  const end = agent.endedTs || Date.now();
  return window.fmtDur(end - agent.startedTs);
}

// Strips the mcp__<server>__ prefix Claude prepends to MCP tool names.
export function stripMcpPrefix(name) {
  return (name || "tool").replace(/^mcp__[^_]+__/, "");
}
