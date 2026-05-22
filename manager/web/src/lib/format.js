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

// Tool family classification — drives both icon picking and which renderer
// the Feed's ToolBlock dispatcher chooses. Keep these aligned with the
// renderer registry in components/tools/ToolBlock.jsx.
const FAMILY_TABLE = {
  Read: "read", NotebookRead: "read",
  Write: "write",
  Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "bash", BashOutput: "bash", KillShell: "bash", KillBash: "bash",
  Grep: "search", Glob: "search",
  ToolSearch: "toolsearch",
  WebFetch: "web", WebSearch: "web",
  Task: "task",
  TodoWrite: "todo",
  ExitPlanMode: "plan",
  spawn_worker: "orch", list_workers: "orch", get_worker: "orch",
  kill_worker: "orch", list_pending_permissions: "orch",
};

export function toolFamily(name) {
  const base = stripMcpPrefix(name);
  return FAMILY_TABLE[base] || "generic";
}

const FAMILY_ICON = {
  read: "read",
  write: "filePlus",
  edit: "edit",
  bash: "terminal",
  search: "grep",
  toolsearch: "search",
  web: "globe",
  task: "agentSpawn",
  orch: "spawn",
  todo: "checkSquare",
  plan: "scroll",
  generic: "tool",
};

export function toolIcon(name) {
  return FAMILY_ICON[toolFamily(name)] || "tool";
}

// Reads Date.now() at call time so the App's elapsedTickMs interval keeps
// counters smooth without waiting on the next poll.
export function liveElapsed(agent) {
  if (!agent || !agent.startedTs) return "—";
  const end = agent.endedTs || Date.now();
  return window.fmtDur(end - agent.startedTs);
}

// Strips the mcp__<server>__ prefix Claude prepends to MCP tool names. Server
// names can contain underscores (e.g. `claude_ai_Gmail`), so we locate the
// second `__` separator by scan rather than a `[^_]+` charclass.
export function stripMcpPrefix(name) {
  if (!name) return "tool";
  if (!name.startsWith("mcp__")) return name;
  const idx = name.indexOf("__", 5);
  return idx < 0 ? name : name.slice(idx + 2);
}

// Pulls an absolute file path out of a tool's structured input, when the
// tool is one that operates on a single file. Returns null for everything
// else (Bash, Glob/Grep over directories, MCP tools, etc).
export function filePathFromToolInput(toolName, input) {
  if (!input || typeof input !== "object") return null;
  const base = stripMcpPrefix(toolName);
  const key = base === "NotebookEdit" || base === "NotebookRead" ? "notebook_path"
    : (base === "Read" || base === "Edit" || base === "Write" || base === "MultiEdit") ? "file_path"
    : null;
  if (!key) return null;
  const v = input[key];
  return typeof v === "string" && v.startsWith("/") ? v : null;
}
