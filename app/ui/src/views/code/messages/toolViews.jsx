// Single source of truth for how a tool renders in the chat. Each descriptor
// owns one tool's presentation: header labels (idle + running), optional header
// decorations (clickable file path, diff stats, clickable agent ref, expand
// gate), and the expanded Detail body.
// ToolItem reads from here instead of switching on tool.name, so adding a tool
// means registering one entry — no edits to ToolItem/ToolDetail (Open/Closed).
// This is the ONLY tool-render dispatcher; the worker-management tools are
// registered here too (their bodies live in WorkerToolCard.jsx).
//
// Unknown tools resolve to FALLBACK, whose GenericToolCard shows a humanized
// name + args hint in the header and a parameters/output/raw-payload card body.

import {
  ReadDetail, EditDetail, WriteDetail, BashDetail, AskUserQuestionDetail,
  AskUserDetail, SkillDetail, NotifyDetail, MessageDetail, GenericToolCard,
  PeerAskDetail, PeerRespondDetail, PeerListDetail,
  CreateWorkerDetail, AvailableWorkersDetail, DatetimeDetail,
} from "./ToolDetail.jsx";
import { gitActions, gitVerbLabel } from "../../../lib/messageParser.js";
import { skillFilePath } from "../../../lib/skillBody.js";
import { skillNameFromRead } from "../../../lib/skillName.js";
import { toolDisplayName } from "../../../lib/toolDisplayName.js";
import { argsSummary } from "../../../lib/toolArgs.js";
import { WORKER_TOOL_SPECS } from "../../../lib/workerTools.js";
import { WorkerToolBody, workerIdentity, workerListCount, workerToolDetailText } from "./WorkerToolCard.jsx";
import { WorkflowToolDetail, workflowLabel, workflowRunningLabel, workflowHeaderBadge } from "./WorkflowCard.jsx";
import { spawnLoopDetails } from "../../../lib/loopDisplay.js";

// Shared base that every registered (bespoke) view inherits via register().
// Its header is a neutral "Used <displayName>"; bespoke views override what they
// need. `summary` is null here so bespoke tools (which already encode their hint
// in label.file) show no extra args summary — only the FALLBACK surfaces one.
const BASE = {
  label: (t) => ({ verb: "Used", file: toolDisplayName(t.name) }),
  runningLabel: (t) => ({ verb: "Running", file: toolDisplayName(t.name) }),
  summary: () => null,
  filePath: () => null,
  stats: () => null,
  agentRef: () => null,
  headerBadge: () => null,
  expandable: () => true,
  Detail: GenericToolCard,
};

// The fallback for any unregistered tool — BASE plus a generic args hint in the
// header so an unknown tool still says *what* it acted on.
const FALLBACK = { ...BASE, summary: (t) => argsSummary(t.input) };

const VIEWS = new Map();
const register = (name, view) => VIEWS.set(name, { ...BASE, ...view });

export function getToolView(name) {
  return VIEWS.get(name ?? "") ?? FALLBACK;
}

function fileName(p) {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const filePathOf = (t) => t.input?.file_path ?? null;

register("Read", {
  label: (t) => ({
    verb: "Read",
    file: skillNameFromRead(t.input?.file_path, t.result?.text) ?? fileName(t.input?.file_path),
  }),
  runningLabel: (t) => ({ verb: "Reading", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  Detail: ReadDetail,
});

register("Edit", {
  label: (t) => ({ verb: "Edit", file: fileName(t.input?.file_path) }),
  runningLabel: (t) => ({ verb: "Editing", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  stats: editStats,
  Detail: EditDetail,
});

register("Write", {
  label: (t) => ({ verb: "Write", file: fileName(t.input?.file_path) }),
  runningLabel: (t) => ({ verb: "Writing", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  Detail: WriteDetail,
});

register("Bash", {
  label: bashLabel,
  runningLabel: (t) => ({ verb: "Running", file: (t.input?.command ?? "").slice(0, 60) }),
  Detail: BashDetail,
});

const searchLabel = (t) => ({ verb: "Searching", file: t.input?.pattern ?? t.input?.query ?? "" });
register("Glob", { runningLabel: searchLabel });
register("Grep", { runningLabel: searchLabel });

register("WebSearch", {
  label: (t) => ({ verb: "Searched the web", file: t.input?.query ?? "" }),
  runningLabel: (t) => ({ verb: "Searching the web", file: t.input?.query ?? "" }),
});

register("WebFetch", {
  label: (t) => ({ verb: "Fetched", file: hostOf(t.input?.url) }),
  runningLabel: (t) => ({ verb: "Fetching", file: hostOf(t.input?.url) }),
});

register("AskUserQuestion", {
  label: () => ({ verb: "Asked", file: "user" }),
  runningLabel: () => ({ verb: "Asking", file: "user" }),
  Detail: AskUserQuestionDetail,
});

register("Skill", {
  label: (t) => ({ verb: "Used", file: `${t.input?.skill ?? "skill"} skill` }),
  runningLabel: (t) => ({ verb: "Using", file: `${t.input?.skill ?? "skill"} skill` }),
  filePath: (t) => skillFilePath(t.skillPath),
  Detail: SkillDetail,
});

register("mcp__orchestrator__ask_user", {
  label: () => ({ verb: "Asked", file: "user" }),
  runningLabel: () => ({ verb: "Asking", file: "user" }),
  Detail: AskUserDetail,
});

register("mcp__orchestrator__notify_user", {
  label: () => ({ verb: "Notified", file: "user" }),
  runningLabel: () => ({ verb: "Notifying", file: "user" }),
  Detail: NotifyDetail,
});

register("mcp__orchestrator__create_worker", {
  label: (t) => ({ verb: "Created worker", file: t.input?.name ?? "" }),
  runningLabel: (t) => ({ verb: "Creating worker", file: t.input?.name ?? "" }),
  Detail: CreateWorkerDetail,
});

register("mcp__orchestrator__list_available_workers", {
  label: (t) => {
    const n = availableWorkersCount(t);
    return { verb: "Listed", file: n != null ? `available workers (${n})` : "available workers" };
  },
  runningLabel: () => ({ verb: "Listing", file: "available workers" }),
  Detail: AvailableWorkersDetail,
});

function availableWorkersCount(t) {
  const text = t.result?.text ?? "";
  if (!text.startsWith("[")) return null;
  try {
    const a = JSON.parse(text);
    return Array.isArray(a) ? a.length : null;
  } catch {
    return null;
  }
}

register("mcp__orchestrator__workflow", {
  label: workflowLabel,
  runningLabel: workflowRunningLabel,
  headerBadge: workflowHeaderBadge,
  Detail: WorkflowToolDetail,
});

register("mcp__worker__send_message_to_parent", {
  label: () => ({ verb: "Sent report to", file: "orchestrator" }),
  agentRef: (t, ctx) => (ctx?.parent ? { id: ctx.parent.id, name: ctx.parent.name } : null),
  Detail: MessageDetail,
});

register("mcp__worker__list_peers", {
  label: () => ({ verb: "Listed", file: "peers" }),
  runningLabel: () => ({ verb: "Listing", file: "peers" }),
  Detail: PeerListDetail,
});

register("mcp__worker__ask_peer", {
  label: (t) => ({ verb: "Asked", file: t.peerTo?.name ?? t.input?.peerId ?? "peer" }),
  runningLabel: (t) => ({ verb: "Asking", file: t.peerTo?.name ?? t.input?.peerId ?? "peer" }),
  // Prefer the durable peer name the parser linked from the peer_consult event
  // (still correct after the peer is killed); fall back to live resolution by id.
  agentRef: (t) => t.peerTo ?? (t.input?.peerId ? { id: t.input.peerId, name: null } : null),
  Detail: PeerAskDetail,
});

// respond_to_peer's input has no asker. Prefer the asker the parser linked from
// the turn's peer_request event (tool.peerTo — works for existing messages too);
// fall back to the daemon's JSON result (covers the case where that event isn't
// in the loaded window).
function peerReplyResult(t) {
  const text = t.result?.text ?? "";
  if (!text.startsWith("{")) return null;
  try {
    const r = JSON.parse(text);
    return r.toWorker ? { id: r.toWorker, name: r.toName ?? null } : null;
  } catch {
    return null;
  }
}
const peerReplyTo = (t) => t.peerTo ?? peerReplyResult(t);

register("mcp__worker__respond_to_peer", {
  label: (t) => ({ verb: "Replied to", file: peerReplyTo(t)?.name ?? "peer" }),
  runningLabel: (t) => ({ verb: "Replying to", file: peerReplyTo(t)?.name ?? "peer" }),
  agentRef: (t) => peerReplyTo(t),
  Detail: PeerRespondDetail,
});

// current_datetime — same tool on both lanes (worker + orchestrator); one
// single-line body surfaces the result's ready-to-show `formatted` string.
for (const name of ["mcp__orchestrator__current_datetime", "mcp__worker__current_datetime"]) {
  register(name, {
    label: () => ({ verb: "Checked", file: "date & time" }),
    runningLabel: () => ({ verb: "Checking", file: "date & time" }),
    Detail: DatetimeDetail,
  });
}

// Worker-management MCP tools — folded into this registry so every tool
// dispatches through getToolView. Verbs come from WORKER_TOOL_SPECS (shared with
// the parser's lane grouping); the body is WorkerToolBody. The expand gate keeps
// the prior behavior: a row with no detail text (e.g. a still-running call) is
// non-expandable. spawn/kill/message/get name their target via a click-to-select
// AgentLink (agentRef); the list tools show a count/label instead.
const workerExpandable = (t, ctx) => workerToolDetailText(t, ctx?.workers).trim().length > 0;

// A worker armed with a dynamic loop AT SPAWN carries the static loop args in
// the tool input — surface a "loop" pill at the right of the agent name so the
// arm-at-spawn is visible the instant the call lands (live loop state drives the
// sidebar badge / transcript card separately). No loop arg → no badge.
const spawnLoopBadge = (t) =>
  t.input?.loop
    ? <span className="ti-loop-badge" title={spawnLoopDetails(t.input.loop)}>loop</span>
    : null;

register("mcp__orchestrator__spawn_worker", {
  label: () => ({ verb: WORKER_TOOL_SPECS.mcp__orchestrator__spawn_worker.verb, file: "" }),
  runningLabel: () => ({ verb: WORKER_TOOL_SPECS.mcp__orchestrator__spawn_worker.running, file: "" }),
  agentRef: (t, ctx) => workerIdentity(t, ctx?.workers),
  headerBadge: spawnLoopBadge,
  expandable: workerExpandable,
  Detail: WorkerToolBody,
});

for (const name of [
  "mcp__orchestrator__kill_worker",
  "mcp__orchestrator__message_worker",
  "mcp__orchestrator__get_worker",
]) {
  register(name, {
    label: () => ({ verb: WORKER_TOOL_SPECS[name].verb, file: "" }),
    runningLabel: () => ({ verb: WORKER_TOOL_SPECS[name].running, file: "" }),
    agentRef: (t, ctx) => workerIdentity(t, ctx?.workers),
    expandable: workerExpandable,
    Detail: WorkerToolBody,
  });
}

register("mcp__orchestrator__list_active_workers", {
  label: (t) => {
    const n = workerListCount(t);
    return { verb: WORKER_TOOL_SPECS[t.name].verb, file: n != null ? `workers (${n})` : "workers" };
  },
  runningLabel: (t) => ({ verb: WORKER_TOOL_SPECS[t.name].running, file: "workers" }),
  expandable: workerExpandable,
  Detail: WorkerToolBody,
});

register("mcp__orchestrator__list_pending_permissions", {
  label: (t) => ({ verb: WORKER_TOOL_SPECS[t.name].verb, file: "pending permissions" }),
  runningLabel: (t) => ({ verb: WORKER_TOOL_SPECS[t.name].running, file: "pending permissions" }),
  expandable: workerExpandable,
  Detail: WorkerToolBody,
});

function editStats(tool) {
  const oldLines = (tool.input?.old_string ?? "").split("\n");
  const newLines = (tool.input?.new_string ?? "").split("\n");
  const m = oldLines.length, n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const shared = dp[m][n];
  return { add: n - shared, del: m - shared };
}

function bashLabel(tool) {
  const actions = gitActions(tool);
  if (actions.length === 0) return { verb: "Ran", file: (tool.input?.command ?? "").slice(0, 60) };
  const shas = actions.flatMap((a) => a.shas ?? []);
  const file = shas.length > 0 ? shas.join(", ") : actions[actions.length - 1].detail;
  return { verb: gitVerbSummary(actions), file };
}

function gitVerbSummary(actions) {
  const counts = [];
  for (const a of actions) {
    const c = counts.find((x) => x.verb === a.verb);
    if (c) c.n++;
    else counts.push({ verb: a.verb, n: 1 });
  }
  return counts.map(({ verb, n }) => gitVerbLabel(verb, n)).join(", ");
}
