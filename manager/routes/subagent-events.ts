import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import type { WorkerEventRow } from "../../contracts/src/events.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { sanitizeEventRowForDisplay } from "../shared/display-sanitize.ts";
import { PROMPT_EVENT_TYPES } from "./prompt-events.ts";

type Payload = Record<string, any>;
// One tool call a row is about; `parent` is the subagent call an inner tool runs under.
// `name` is set on the row that starts the call.
type CallRef = { id?: string; parent?: string; name?: string; launchesSubagent?: boolean };

const parse = (row: WorkerEventRow): Payload => {
  try { return row.payload ? JSON.parse(row.payload) : {}; } catch { return {}; }
};

// Rows are canonical agent_event rows or the legacy jsonl / tool_running /
// tool_done shapes (app/ui/src/lib/messageParser.js decodes both) — read the
// tool calls out of either.
function callRefs(row: WorkerEventRow, p: Payload): CallRef[] {
  if (row.type === "agent_event") {
    if (p.type === "message") {
      return (p.blocks ?? [])
        .filter((b: Payload) => b.type === "tool_call" || b.type === "tool_result")
        .map((b: Payload) => b.type === "tool_call"
          ? { id: b.callId, name: b.name, launchesSubagent: b.spawnsSubagent === true || b.name === "Agent" }
          : { id: b.callId });
    }
    if (p.type === "activity") {
      const started = p.kind === "tool_started";
      return [{ id: p.callId, parent: p.parentCallId, name: started ? p.toolName : undefined, launchesSubagent: started && p.toolName === "Agent" && !p.parentCallId }];
    }
    return [];
  }
  if (row.type === "jsonl") {
    if (p.kind === "tool_use") return [{ id: p.id, name: p.name, launchesSubagent: p.spawnsSubagent === true || p.name === "Agent" }];
    if (p.kind === "tool_result") return [{ id: p.toolUseId }];
    return [];
  }
  if (row.type === "tool_running" || row.type === "tool_done") {
    const started = row.type === "tool_running";
    return [{ id: p.toolUseId, parent: p.parentAgentToolUseId, name: started ? p.toolName : undefined, launchesSubagent: started && p.toolName === "Agent" && !p.parentAgentToolUseId }];
  }
  return [];
}

// Closes still-open tools in the web's lifecycle (app/ui/src/lib/toolLifecycle.js
// + the agent_event turn/session rows messageParser.js turns into barriers) —
// keep the three in step.
function isBarrier(row: WorkerEventRow, p: Payload): boolean {
  switch (row.type) {
    case "exit": return true;
    case "hook": return p.event === "Stop" || p.event === "SessionEnd";
    case "state": return p.state === "IDLE" || p.state === "ENDING" || p.state === "DONE";
    case "lifecycle": return p.phase === "interrupted" || p.phase === "delivery_failed" || p.phase === "pty_exit";
    case "agent_event": return (p.type === "turn" && p.phase !== "started") || (p.type === "session" && p.phase === "ended");
    default: return false;
  }
}

const ALWAYS_KEPT = new Set<string>([...PROMPT_EVENT_TYPES, "subagent_started", "subagent_completed", "subagent_profile"]);

const isSubagentLifecycle = (row: WorkerEventRow, p: Payload): boolean =>
  row.type === "agent_event" && (p.type === "subagent_started" || p.type === "subagent_completed" || p.type === "subagent_profile");

// Every row the web needs to rebuild each subagent of the whole conversation —
// its launch, inner tools, result and lifecycle — and each Artifact call with
// its result, plus the prompt/marker rows (clear, rewind, recall act on them)
// and the turn barriers. The transcript window pages lazily; the Subagents
// panel and the Environment popover's Artifacts section must not.
export function selectSubagentRows(rows: WorkerEventRow[]): WorkerEventRow[] {
  const parsed = rows.map((r) => (r.payload ? parse(r) : {}));
  const refs = rows.map((r, i) => callRefs(r, parsed[i]));

  const agentIds = new Set<string>();
  for (const rowRefs of refs) for (const ref of rowRefs) if (ref.launchesSubagent && ref.id) agentIds.add(ref.id);

  const wanted = new Set(agentIds);
  for (const rowRefs of refs) {
    for (const ref of rowRefs) {
      if (ref.id && ((ref.parent && agentIds.has(ref.parent)) || ref.name === "Artifact")) wanted.add(ref.id);
    }
  }

  return rows.filter((r, i) =>
    ALWAYS_KEPT.has(r.type)
    || isSubagentLifecycle(r, parsed[i])
    || isBarrier(r, parsed[i])
    || refs[i].some((ref) => (ref.id && wanted.has(ref.id)) || (ref.parent && wanted.has(ref.parent))));
}

export function registerSubagentEventRoutes(r: Router, c: Container): void {
  r.get(/^\/workers\/(?<id>[^/]+)\/subagent-events$/, ({ params, res }) => {
    // limit -1 = every retained row (SQLite); ts/id-ASC like the window's order.
    const rows = c.events.list({ workerId: params.id, since: 0, limit: -1, order: "asc" });
    writeJson(res, 200, selectSubagentRows(rows).map(sanitizeEventRowForDisplay));
  });
}
