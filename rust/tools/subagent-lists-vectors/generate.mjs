#!/usr/bin/env node
// Writes rust/fixtures/subagent-lists/vectors.json: invented conversations and
// what the dashboard derives from them today — the rows
// /workers/:id/subagent-events answers (manager/routes/subagent-events.ts),
// parsed by app/ui/src/lib/messageParser.js and listed by collectSubagents /
// collectArtifacts, each subagent in the summary shape the core answers
// (app/ui/src/lib/subagentSummary.js). For crates/eos-domain's
// tests/subagent_lists.rs.
//
//   node rust/tools/subagent-lists-vectors/generate.mjs            write
//   node rust/tools/subagent-lists-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 and `npm ci` in app/ui.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, listsOf, subagentEvents } from "./lib.mjs";

const OUT = path.join(REPO, "rust/fixtures/subagent-lists/vectors.json");

// ---- invented logs ----------------------------------------------------------

let nextId = 0;
let clock = 1_790_000_000_000;
function log(build) {
  nextId = 0;
  clock = 1_790_000_000_000;
  const rows = [];
  const row = (type, payload, dt = 10) => {
    const r = { id: ++nextId, worker_id: "w-T", ts: (clock += dt), type, payload: payload === undefined ? null : JSON.stringify(payload) };
    rows.push(r);
    return r;
  };
  const ev = (payload, dt) => row("agent_event", payload, dt);
  const h = {
    row,
    ev,
    user: (text, extra = {}) => row("user_message", { text, ...extra }),
    orch: (text) => row("orchestrator_message", { text }),
    text: (text) => ev({ type: "message", role: "assistant", blocks: [{ type: "text", text }] }),
    call: (callId, name, input, extra = {}) =>
      ev({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name, input, ...extra }] }),
    calls: (...blocks) => ev({ type: "message", role: "assistant", blocks: blocks.map((b) => ({ type: "tool_call", ...b })) }),
    agent: (callId, input) => h.call(callId, "Agent", input, { spawnsSubagent: true }),
    result: (callId, content, isError) =>
      ev({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId, content, ...(isError ? { isError: true } : {}) }] }),
    started: (callId, toolName, input, parentCallId) =>
      ev({ type: "activity", kind: "tool_started", callId, toolName, input, ...(parentCallId ? { parentCallId } : {}) }),
    finished: (callId, toolName, result, parentCallId, isError = false) =>
      ev({ type: "activity", kind: "tool_finished", callId, toolName, result, isError, ...(parentCallId ? { parentCallId } : {}) }),
    alive: () => ev({ type: "activity", kind: "alive" }),
    turnEnd: (phase = "ended") => ev({ type: "turn", phase }),
    turnStart: () => ev({ type: "turn", phase: "started" }),
    idle: () => row("state", { state: "IDLE" }),
    working: () => row("state", { state: "WORKING" }),
    sessionEnd: () => ev({ type: "session", phase: "ended" }),
    subStarted: (callId, agentId, extra = {}) => ev({ type: "subagent_started", callId, agentId, background: true, ...extra }),
    subDone: (callId, agentId, extra = {}) => ev({ type: "subagent_completed", callId, agentId, status: "completed", result: "report", ...extra }),
    profile: (callId, model, effort) => ev({ type: "subagent_profile", callId, model, ...(effort ? { effort } : {}) }),
  };
  build(h);
  return rows;
}

const CODE_URL = "https://claude.ai/code/artifact/0b5e7a2c-1111-4222-8333-444455556666";
const SHORT_URL = "https://claude.ai/artifact/YBc8tWaKTvYp8FQwVJdRkM";

const scenarios = [
  {
    name: "foreground subagents finish, run, or are cut by the turn's end",
    log: log((h) => {
      h.user("look around");
      h.call("read-1", "Read", { file_path: "/w/a.md" });
      h.result("read-1", "file text");
      h.agent("ag-done", { description: "Map the repo", prompt: "Map it all", subagent_type: "Explore", model: "haiku" });
      h.started("in-1", "Grep", { pattern: "TODO", path: "/w" }, "ag-done");
      h.finished("in-1", "Grep", "3 matches", "ag-done");
      h.started("in-2", "Read", { file_path: "/w/b.rs" }, "ag-done");
      h.finished("in-2", "Read", "", "ag-done");
      h.result("ag-done", "All mapped.<usage>x</usage>");
      h.agent("ag-cut", { prompt: "p".repeat(150) });
      h.started("in-3", "Bash", { command: "sleep 100", description: "wait" }, "ag-cut");
      h.turnEnd();
      h.idle();
      h.user("again");
      h.working();
      h.agent("ag-live", { summary: "Live one", prompt: "Keep going" });
      h.started("in-4", "Bash", { command: "x".repeat(300), description: "a long one", timeout: 5, run_in_background: false, nested: { a: 1 }, list: [1] }, "ag-live");
      h.finished("in-4", "Bash", "ok", "ag-live");
      h.started("in-5", "Write", { file_path: "/w/c.txt", content: "😀".repeat(150) }, "ag-live");
      h.started("in-6", "Read", { file_path: "/w/d.txt" }, "ag-live");
      h.finished("in-6", "Read", "d", "ag-live");
    }),
  },
  {
    name: "background subagents end with their completion, the session, or keep running past turns",
    log: log((h) => {
      h.user("do it in the background");
      h.agent("bg-1", { description: "Background one", prompt: "go", run_in_background: true });
      h.result("bg-1", "launched");
      h.subStarted("bg-1", "a-1");
      h.profile("bg-1", "claude-sonnet-4-5", "high");
      h.started("bi-1", "Glob", { pattern: "**/*.rs" }, "bg-1");
      h.agent("bg-2", { description: "Never ends", prompt: "go" });
      h.result("bg-2", "launched");
      h.subStarted("bg-2", "a-2");
      h.started("bi-2", "Bash", { command: "make" }, "bg-2");
      h.turnEnd();
      h.idle();
      h.finished("bi-1", "Glob", "files", "bg-1");
      h.ev({ type: "subagent_completed", agentId: "a-1", status: "failed", result: "broke", usage: { totalTokens: 10, toolUses: 1, durationMs: 4200 } });
      h.agent("bg-3", { description: "Stopped by exit", prompt: "go" });
      h.result("bg-3", "launched");
      h.subStarted("bg-3", "a-3");
      h.profile("bg-3", null, "low");
      h.sessionEnd();
      h.row("exit", { code: 0 });
    }),
  },
  {
    name: "a stopped subagent continued by a message is one subagent with two runs",
    log: log((h) => {
      h.user("start");
      h.agent("r-1", { description: "Researcher", prompt: "research", subagent_type: "general-purpose" });
      h.result("r-1", "launched");
      h.subStarted("r-1", "agent-r");
      h.started("ri-1", "WebSearch", { query: "rust sqlite" }, "r-1");
      h.finished("ri-1", "WebSearch", "results", "r-1");
      h.subDone("r-1", "agent-r", { status: "stopped" });
      h.turnEnd();
      h.idle();
      h.user("continue it");
      h.call("send-1", "SendMessage", { to: "agent-r", message: "Please also check the docs", summary: "" });
      h.result("send-1", "sent");
      h.subStarted("send-1", "agent-r");
      h.started("ri-2", "WebFetch", { url: "https://docs.rs" }, "send-1");
      h.subDone("send-1", "agent-r", { usage: { durationMs: 1500 } });
      h.call("send-2", "SendMessage", { to: "x", message: "third run" });
      h.subStarted("send-2", "agent-other", { resumes: "send-1" });
      h.call("send-3", "SendMessage", { message: "orphan" });
      h.subStarted("send-3", "agent-new", { resumes: "gone" });
      h.turnEnd();
    }),
  },
  {
    name: "rows of the older lanes: transcript lines and hook pulses",
    log: log((h) => {
      h.user("legacy");
      h.row("tool_running", { toolName: "Agent", toolUseId: "lg-1", input: { description: "Pulse first", prompt: "x" } });
      h.row("tool_running", { toolName: "Read", toolUseId: "lgi-1", input: { file_path: "/w/x" }, parentAgentToolUseId: "lg-1" });
      h.row("tool_done", { toolName: "Read", toolUseId: "lgi-1", result: "x" });
      h.row("jsonl", { kind: "tool_use", id: "lg-1", name: "Agent", input: { description: "Pulse first", prompt: "x" }, tsTranscript: 1_790_000_000_005, parentModel: "opus" });
      h.row("tool_running", { toolName: "Grep", toolUseId: "stray-1", input: { pattern: "y" } });
      h.row("tool_done", { toolName: "Agent", toolUseId: "lg-1", result: "" });
      h.row("jsonl", { kind: "tool_result", toolUseId: "lg-1", text: "done", tsTranscript: 1_790_000_000_400 });
      h.row("tool_running", { toolName: "Agent", toolUseId: "lg-2", input: { prompt: "pulse only" } });
      h.row("tool_running", { toolName: "Bash", toolUseId: "lgi-2", input: { command: "ls" }, parentAgentToolUseId: "lg-2" });
      h.row("hook", { event: "Stop" });
      h.row("jsonl", { kind: "tool_use", id: "lg-3", name: "Task", spawnsSubagent: true, input: { description: "Marked" } });
      h.row("lifecycle", { phase: "interrupted" });
      h.row("lifecycle", { phase: "pty_exit" });
    }),
  },
  {
    name: "a rewind hides the abandoned branch but keeps the subagents that ended there",
    bootPromptOffset: 1,
    log: log((h) => {
      h.orch("the task");
      h.agent("rw-1", { description: "Before", prompt: "a", run_in_background: true });
      h.subStarted("rw-1", "a-rw1");
      h.user("<msg id=\"m-1\"/>\nsecond   question");
      h.agent("rw-2", { description: "Abandoned", prompt: "b" });
      h.subDone("rw-1", "a-rw1");
      h.row("conversation_rewound", { text: "second question extended" });
      h.user("third");
      h.agent("rw-3", { description: "After", prompt: "c" });
      h.result("rw-3", "ok");
      h.agent("rw-4", { description: "Dropped by index", prompt: "d" });
      h.row("conversation_rewound", { index: 2 });
      h.agent("rw-5", { description: "Kept", prompt: "e" });
    }),
  },
  {
    name: "a clear wipes earlier subagents; a recalled message no longer anchors a rewind",
    log: log((h) => {
      h.agent("cl-1", { description: "Wiped", prompt: "a" });
      h.row("conversation_cleared", {});
      h.user("first", { clientMsgIds: ["c-1"] });
      h.agent("cl-2", { description: "Survivor", prompt: "b" });
      h.user("recalled one", { clientMsgIds: ["c-2"] });
      h.row("message_recalled", { clientMsgId: "c-2" });
      h.user("recalled by row");
      h.row("message_recalled", { recalledRowId: nextId });
      h.agent("cl-3", { description: "Third", prompt: "c" });
      h.row("conversation_rewound", { text: "recalled" });
    }),
  },
  {
    name: "artifacts: published, updated, opened, failed, uploaded, and from a subagent",
    log: log((h) => {
      h.user("make pages");
      h.call("art-1", "Artifact", { file_path: "/tmp/Release Notes.html" });
      h.result("art-1", `Published ${CODE_URL}`);
      h.call("art-2", "Artifact", { url: CODE_URL, file_path: "/tmp/data.json", root: "/tmp/site", title: "" });
      h.result("art-2", `Updated ${CODE_URL}`);
      h.call("art-3", "Artifact", { action: "open", url: SHORT_URL });
      h.result("art-3", "opened");
      h.call("art-4", "Artifact", { file_path: "/tmp/broken.md" });
      h.result("art-4", `Failed ${SHORT_URL}`, true);
      h.call("art-5", "Artifact", { asset: true, file_path: "/tmp/pic.png", url: CODE_URL });
      h.call("art-6", "Artifact", { action: "quickstart" });
      h.result("art-6", `see ${SHORT_URL}`);
      h.call("art-7", "Artifact", { root: "/tmp/typed", file_path: "/tmp/typed/data.md" });
      h.result("art-7", "Published https://claude.ai/code/artifact/not-a-uuid");
      h.agent("art-ag", { description: "Publisher", prompt: "publish" });
      h.started("art-in", "Artifact", { title: "From a subagent" }, "art-ag");
      h.finished("art-in", "Artifact", "Published https://preview.claude.com/artifact/YBc8tWaKTvYp8FQwVJdRkN", "art-ag");
      h.started("art-in2", "Artifact", { file_path: "/x/later.HTM" }, "art-ag");
      h.finished("art-in2", "Artifact", `Updated ${CODE_URL}`, "art-ag");
      h.result("art-ag", "done");
      h.call("art-8", "Artifact", {});
    }),
  },
  {
    name: "repeated rows and calls batched in one message",
    log: log((h) => {
      h.user("batch");
      h.calls(
        { callId: "b-1", name: "Agent", spawnsSubagent: true, input: { description: "One" } },
        { callId: "b-2", name: "Task", spawnsSubagent: true, input: { description: "Two", model: "sonnet" } },
        { callId: "b-read", name: "Read", input: { file_path: "/w" } },
      );
      h.started("bi-1", "Read", { file_path: "/w/1" }, "b-1");
      h.started("bi-1", "Read", { file_path: "/w/1" }, "b-1");
      h.started("bi-2", "Edit", { file_path: "/w/2", old_string: "a", new_string: "b" }, "b-2");
      h.finished("bi-2", "Edit", "edited", "b-2");
      h.started("bi-3", "Bash", { command: "ls" }, "b-unknown");
      h.result("b-1", "one done");
      h.agent("b-1", { description: "One again" });
      h.alive();
      h.text("all done");
    }),
  },
];

const vectors = scenarios.map(({ name, log: rows, bootPromptOffset = 0 }) => {
  const answer = subagentEvents(rows);
  return { name, bootPromptOffset, rows, expected: listsOf(answer, bootPromptOffset) };
});

const text = JSON.stringify({ generatedBy: "rust/tools/subagent-lists-vectors/generate.mjs", vectors }, null, 1) + "\n";
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch {}
  if (current !== text) {
    console.error(`${path.relative(REPO, OUT)} is out of date: run node rust/tools/subagent-lists-vectors/generate.mjs`);
    process.exit(1);
  }
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(REPO, OUT)}: ${vectors.length} conversations, ${vectors.reduce((n, v) => n + v.expected.subagents.length, 0)} subagents, ${vectors.reduce((n, v) => n + v.expected.artifacts.length, 0)} artifacts`);
}
