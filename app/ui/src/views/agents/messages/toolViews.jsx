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
  ReadDetail, EditDetail, MultiEditDetail, WriteDetail, BashDetail, AskUserQuestionDetail,
  AskUserDetail, SkillDetail, NotifyDetail, MessageDetail, GenericToolCard,
  PeerAskDetail, PeerRespondDetail, PeerListDetail,
  CreateWorkerDetail, AvailableWorkersDetail, DatetimeDetail,
  TaskCreateDetail, TaskUpdateDetail, TaskGetDetail, TaskListDetail, TodoWriteDetail,
  ToolSearchDetail, ScheduleWakeupDetail, TaskOutputDetail, formatDelay,
  taskStatusBadge, parseTaskGet, parseTaskListRows, parseToolSearchNames, datetimeFormatted,
} from "./ToolDetail.jsx";
import { gitActions, gitVerbLabel } from "../../../lib/messageParser.js";
import { skillFilePath } from "../../../lib/skillBody.js";
import { skillNameFromRead } from "../../../lib/skillName.js";
import { toolDisplayName } from "../../../lib/toolDisplayName.js";
import { argsSummary } from "../../../lib/toolArgs.js";
import { WORKER_TOOL_SPECS } from "../../../lib/workerTools.js";
import { WorkerToolBody, workerIdentity, workerListCount, workerToolDetailText, killedBranch } from "./WorkerToolCard.jsx";
import { spawnLoopDetails } from "../../../lib/loopDisplay.js";
import { artifactFromTool } from "../../../lib/artifactLink.js";
import { ArtifactChip } from "./ArtifactChip.jsx";
import { WebSearchDetail, WebFetchDetail } from "./WebToolCards.jsx";
import { parseWebSearch, groupBySite, splitUrl } from "../../../lib/webSources.js";
import { PAGE_TOOL_VIEWS } from "./PageToolViews.jsx";
import { MEMORY_TOOL_VIEWS } from "./MemoryToolViews.jsx";

// Shared base that every registered (bespoke) view inherits via register().
// Its header is a neutral "Used <displayName>"; bespoke views override what they
// need. `summary` is null here so bespoke tools (which already encode their hint
// in label.file) show no extra args summary — only the FALLBACK surfaces one.
const BASE = {
  mono: false,
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

// A body is only worth opening when it says more than the header row already
// does. A failed call always opens (its error text lives in the body).
const failed = (t) => t.result?.isError === true;

// GenericToolCard gate: open only for output, an error, or parameters the
// header's one-line args hint doesn't already show in full.
function genericExpandable(t) {
  if (failed(t) || (t.result?.text ?? "").trim() !== "") return true;
  const params = Object.values(t.input ?? {}).filter((v) => v !== undefined && v !== null);
  if (params.length === 0) return false;
  return params.length > 1 || String(params[0]) !== argsSummary(t.input);
}

// The fallback for any unregistered tool — BASE plus a generic args hint in the
// header so an unknown tool still says *what* it acted on.
const FALLBACK = { ...BASE, summary: (t) => argsSummary(t.input), expandable: genericExpandable };

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

const hostOf = (url) => splitUrl(url)?.host ?? url ?? "";

const filePathOf = (t) => t.input?.file_path ?? null;

register("Read", {
  label: (t) => {
    const skill = skillNameFromRead(t.input?.file_path, t.result?.text);
    return { verb: "Read", file: skill ? `${skill} SKILL` : fileName(t.input?.file_path) };
  },
  runningLabel: (t) => ({ verb: "Reading", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  expandable: failed,
  Detail: ReadDetail,
});

register("Edit", {
  label: (t) => ({ verb: "Edit", file: fileName(t.input?.file_path) }),
  runningLabel: (t) => ({ verb: "Editing", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  stats: editStats,
  Detail: EditDetail,
});

register("MultiEdit", {
  label: (t) => ({ verb: "Edit", file: fileName(t.input?.file_path) }),
  runningLabel: (t) => ({ verb: "Editing", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  stats: multiEditStats,
  Detail: MultiEditDetail,
});

register("Write", {
  label: (t) => ({ verb: "Write", file: fileName(t.input?.file_path) }),
  runningLabel: (t) => ({ verb: "Writing", file: fileName(t.input?.file_path) }),
  filePath: filePathOf,
  // an empty write's body would only repeat the path the header already opens
  expandable: (t) => failed(t) || (t.input?.content ?? "").trim() !== "",
  Detail: WriteDetail,
});

const BASH_HEADER_MAX = 60;

// A finished command with no output whose full text already fits in the header
// has nothing more to show.
function bashExpandable(t) {
  if (t.running || failed(t) || (t.result?.text ?? "").trim() !== "") return true;
  const cmd = t.input?.command ?? "";
  return cmd.length > BASH_HEADER_MAX || cmd.includes("\n");
}

// The header shows the whole command unless it is long, multi-line, or a git
// action summarized as a verb ("Committed abc1234").
function bashHeaderShowsCommand(t) {
  const cmd = t.input?.command ?? "";
  if (cmd.length > BASH_HEADER_MAX || cmd.includes("\n")) return false;
  return t.running === true || gitActions(t).length === 0;
}

// The body repeats the command only when the header couldn't show it.
function BashBody(props) {
  return <BashDetail {...props} showCommand={!bashHeaderShowsCommand(props.tool)} />;
}

register("Bash", {
  mono: true,
  label: bashLabel,
  runningLabel: (t) => ({ verb: "Running", file: (t.input?.command ?? "").slice(0, BASH_HEADER_MAX) }),
  expandable: bashExpandable,
  Detail: BashBody,
});

const searchLabel = (verb) => (t) => ({ verb, file: t.input?.pattern ?? t.input?.query ?? "" });
for (const name of ["Glob", "Grep"]) {
  register(name, {
    mono: true,
    label: searchLabel(name),
    runningLabel: searchLabel("Searching"),
    expandable: genericExpandable,
  });
}

// The header's meta slot counts the sites the search drew on.
function webSearchSourceCount(t) {
  if (!t.result || t.result.isError) return null;
  const n = groupBySite(parseWebSearch(t.result.text).links).length;
  return n > 0 ? `${n} source${n === 1 ? "" : "s"}` : null;
}

register("WebSearch", {
  expandable: genericExpandable,
  label: (t) => ({ verb: "Searched the web", file: t.input?.query ?? "" }),
  runningLabel: (t) => ({ verb: "Searching the web", file: t.input?.query ?? "" }),
  summary: webSearchSourceCount,
  Detail: WebSearchDetail,
});

register("WebFetch", {
  expandable: genericExpandable,
  label: (t) => ({ verb: "Fetched", file: hostOf(t.input?.url) }),
  runningLabel: (t) => ({ verb: "Fetching", file: hostOf(t.input?.url) }),
  summary: (t) => splitUrl(t.input?.url)?.rest || null,
  Detail: WebFetchDetail,
});

// A published/opened claude.ai artifact is one line: verb + the link chip (hover
// peeks, click opens) — nothing to expand. Every other Artifact call
// (quickstart, list, read, uploads, failures) keeps the generic row.
register("Artifact", {
  label: (t) => {
    const artifact = artifactFromTool(t);
    return artifact ? { verb: artifact.verb, file: "" } : BASE.label(t);
  },
  runningLabel: (t) => ((t.input?.action ?? "publish") === "publish"
    ? { verb: "Publishing", file: artifactFromTool(t) ? "" : t.input?.title ?? "" }
    : BASE.runningLabel(t)),
  summary: (t) => (artifactFromTool(t) ? null : FALLBACK.summary(t)),
  expandable: (t) => !artifactFromTool(t) && genericExpandable(t),
  headerBadge: (t) => {
    const artifact = artifactFromTool(t);
    return artifact && <ArtifactChip url={artifact.url} title={artifact.title} />;
  },
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
  // no injected SKILL.md and no args → the body would only echo "Launching skill: x"
  expandable: (t) => !!(t.skillBody || t.skillPath || t.input?.args) || failed(t),
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

// Resolves the targeted peer from whichever addressing path was used (peerId or peerName).
// Mirrors workerIdentity() in WorkerToolCard.jsx: parser-linked peerTo wins; input fields are fallback.
function peerAskTarget(t) {
  const id = t.peerTo?.id ?? t.input?.peerId ?? null;
  const name = t.peerTo?.name ?? t.input?.peerName ?? t.input?.peerId ?? null;
  return (id !== null || name !== null) ? { id, name } : null;
}

register("mcp__worker__ask_peer", {
  label: (t) => ({ verb: "Asked", file: peerAskTarget(t)?.name ?? "peer" }),
  runningLabel: (t) => ({ verb: "Asking", file: peerAskTarget(t)?.name ?? "peer" }),
  agentRef: (t) => peerAskTarget(t),
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

// current_datetime — same tool on both lanes (worker + orchestrator). The
// result's ready-to-show `formatted` string IS the header object, so the row
// never opens unless the call failed.
for (const name of ["mcp__orchestrator__current_datetime", "mcp__worker__current_datetime"]) {
  register(name, {
    label: (t) => ({ verb: "Checked", file: datetimeFormatted(t) || "date & time" }),
    runningLabel: () => ({ verb: "Checking", file: "date & time" }),
    expandable: failed,
    Detail: DatetimeDetail,
  });
}

// Page and memory tools — same tools on both lanes; views in ./PageToolViews.jsx
// and ./MemoryToolViews.jsx.
for (const [tool, view] of Object.entries({ ...PAGE_TOOL_VIEWS, ...MEMORY_TOOL_VIEWS })) {
  for (const server of ["orchestrator", "worker"]) register(`mcp__${server}__${tool}`, view);
}

// Task-management tools (harness built-ins) — the collapsed row says what
// happened at a glance (subject / #id / count) with a status badge; the bodies
// live in ToolDetail.jsx. The result payloads are plain text, so the Get/List
// count + badge parse it (parseTaskGet/parseTaskListRows).
register("TaskCreate", {
  // subject + pending badge are already in the header; only a description adds anything
  expandable: (t) => !!t.input?.description || failed(t),
  label: (t) => ({ verb: "Created task", file: t.input?.subject ?? "" }),
  runningLabel: (t) => ({ verb: "Creating task", file: t.input?.subject ?? "" }),
  headerBadge: () => taskStatusBadge("pending"),
  Detail: TaskCreateDetail,
});

register("TaskUpdate", {
  // a status-only update is fully told by the header badge
  expandable: (t) => {
    const i = t.input ?? {};
    return !!(i.description || i.subject || i.owner || i.addBlocks?.length || i.addBlockedBy?.length) || failed(t);
  },
  label: (t) => ({ verb: "Updated task", file: t.input?.taskId ? `#${t.input.taskId}` : "" }),
  runningLabel: (t) => ({ verb: "Updating task", file: t.input?.taskId ? `#${t.input.taskId}` : "" }),
  headerBadge: (t) => taskStatusBadge(t.input?.status),
  Detail: TaskUpdateDetail,
});

register("TaskGet", {
  expandable: (t) => {
    const task = parseTaskGet(t.result?.text);
    return !!(task?.description || task?.blocks || task?.blockedBy) || failed(t);
  },
  label: (t) => ({ verb: "Read task", file: t.input?.taskId ? `#${t.input.taskId}` : "" }),
  runningLabel: (t) => ({ verb: "Reading task", file: t.input?.taskId ? `#${t.input.taskId}` : "" }),
  headerBadge: (t) => taskStatusBadge(parseTaskGet(t.result?.text)?.status),
  Detail: TaskGetDetail,
});

register("TodoWrite", {
  label: () => ({ verb: "Updated", file: "task list" }),
  runningLabel: () => ({ verb: "Updating", file: "tasks…" }),
  summary: (t) => {
    const todos = t.input?.todos ?? [];
    if (todos.length === 0) return "";
    const nCompleted = todos.filter((t) => t.status === "completed").length;
    const nInProgress = todos.filter((t) => t.status === "in_progress").length;
    const nPending = todos.filter((t) => t.status === "pending").length;
    return `${todos.length} items (${nCompleted} done, ${nInProgress} active, ${nPending} pending)`;
  },
  Detail: TodoWriteDetail,
});

register("TaskList", {
  label: (t) => {
    const n = parseTaskListRows(t.result?.text).length;
    return { verb: "Listed", file: n > 0 ? `tasks (${n})` : "tasks" };
  },
  runningLabel: () => ({ verb: "Listing", file: "tasks" }),
  Detail: TaskListDetail,
});

// ToolSearch / ScheduleWakeup / TaskOutput (harness built-ins) — each encodes its
// hint in label.file (query / human delay / task id), so summary stays null; the
// matched tools, wake reason+prompt, and captured output live in the Detail body.
// "select:Read,Edit" matching exactly Read + Edit — the body would just repeat the query.
function toolSearchExpandable(t) {
  if (failed(t)) return true;
  const names = parseToolSearchNames(t.result?.text);
  if (names.length === 0) return false;
  const q = t.input?.query ?? "";
  if (!q.startsWith("select:")) return true;
  const asked = q.slice("select:".length).split(",").map((s) => s.trim()).filter(Boolean);
  return asked.length !== names.length || !names.every((n) => asked.includes(n));
}

register("ToolSearch", {
  expandable: toolSearchExpandable,
  label: (t) => ({ verb: "Searched tools", file: t.input?.query ?? "" }),
  runningLabel: (t) => ({ verb: "Searching tools", file: t.input?.query ?? "" }),
  Detail: ToolSearchDetail,
});

register("ScheduleWakeup", {
  label: (t) => ({ verb: "Scheduled wakeup", file: formatDelay(t.input?.delaySeconds) }),
  runningLabel: (t) => ({ verb: "Scheduling wakeup", file: formatDelay(t.input?.delaySeconds) }),
  Detail: ScheduleWakeupDetail,
});

register("TaskOutput", {
  label: (t) => ({ verb: "Read task output", file: t.input?.task_id ?? "" }),
  runningLabel: (t) => ({ verb: "Reading task output", file: t.input?.task_id ?? "" }),
  Detail: TaskOutputDetail,
});

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

// kill_worker's body was one "killed · <branch>" line — the header already says
// Killed, so the branch rides along as the row's meta and the row never opens.
register("mcp__orchestrator__kill_worker", {
  label: () => ({ verb: WORKER_TOOL_SPECS.mcp__orchestrator__kill_worker.verb, file: "" }),
  runningLabel: () => ({ verb: WORKER_TOOL_SPECS.mcp__orchestrator__kill_worker.running, file: "" }),
  agentRef: (t, ctx) => workerIdentity(t, ctx?.workers),
  summary: killedBranch,
  expandable: failed,
  Detail: WorkerToolBody,
});

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

function singleEditStats(oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length, n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const shared = dp[m][n];
  return { add: n - shared, del: m - shared };
}

function editStats(tool) {
  return singleEditStats(tool.input?.old_string ?? "", tool.input?.new_string ?? "");
}

function multiEditStats(tool) {
  return (tool.input?.edits ?? []).reduce(
    (acc, e) => {
      const s = singleEditStats(e.old_string ?? "", e.new_string ?? "");
      return { add: acc.add + s.add, del: acc.del + s.del };
    },
    { add: 0, del: 0 }
  );
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
