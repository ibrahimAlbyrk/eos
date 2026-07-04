// Background-subagent signal parsing in the CLI lane's jsonl ingest.
// Fixtures mirror REAL transcript lines (CC 2.1.195+, ~/.claude/projects):
//   - async launch stub        1fbb295a…jsonl L86  (toolUseResult.status "async_launched")
//   - named-agent launch stub  a7893ee8…jsonl L13  (toolUseResult.status "teammate_spawned")
//   - completion carrier       1fbb295a…jsonl L105 (queue-operation enqueue) +
//                              L111 (queued_command attachment duplicate)
//   - foreground contrast      b3e03cc2…jsonl L37  (toolUseResult.status "completed")
// Long prompt/result bodies are shortened; every structural field is verbatim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonlLine, createSubagentParseState, type SubagentParseState } from "../jsonl-parser.ts";
import { toCanonicalEvents } from "../canonical-map.ts";
import { AgentEventSchema } from "../../contracts/src/canonical.ts";

type Event = { type: string; payload: Record<string, unknown> };
const collect = (lines: string[], state: SubagentParseState = createSubagentParseState()): Event[] => {
  const out: Event[] = [];
  for (const line of lines) {
    parseJsonlLine(line, (type, payload) => out.push({ type, payload: payload as Record<string, unknown> }), "opus", state);
  }
  return out;
};
const ofKind = (evs: Event[], kind: string): Event[] =>
  evs.filter((e) => e.type === "jsonl" && e.payload.kind === kind);

const OUTPUT_FILE = "/private/tmp/claude-501/-Users-ibrahimalbyrk-Projects-CC-eos/1fbb295a-4f62-4a6f-8532-c456e607e5e1/tasks/a6fde93a0057787f9.output";

const BG_TOOL_USE_LINE = JSON.stringify({
  parentUuid: "0e0d59f2-0000-4000-8000-000000000000",
  isSidechain: false,
  type: "assistant",
  message: {
    role: "assistant",
    model: "claude-fable-5",
    content: [{
      type: "tool_use",
      id: "toolu_018qvuRQcebp39TA5CYUq6zV",
      name: "Agent",
      input: { description: "Census panel open/close call sites", prompt: "In the repo …, I need a complete census…", subagent_type: "Explore" },
    }],
  },
  timestamp: "2026-07-04T14:41:59.000Z",
});

const BG_STUB_LINE = JSON.stringify({
  parentUuid: "326711dc-edc6-4396-8c31-877380a4b705",
  isSidechain: false,
  promptId: "608890a6-e6bd-4c13-a866-a00634754de1",
  type: "user",
  message: {
    role: "user",
    content: [{
      tool_use_id: "toolu_018qvuRQcebp39TA5CYUq6zV",
      type: "tool_result",
      content: [{ type: "text", text: `Async agent launched successfully.\nagentId: a6fde93a0057787f9 (internal ID - do not mention to user.)\nThe agent is working in the background.\noutput_file: ${OUTPUT_FILE}` }],
    }],
  },
  uuid: "31f8c08b-21e9-4f1c-b4d5-9023bd932d94",
  timestamp: "2026-07-04T14:42:03.943Z",
  toolUseResult: {
    isAsync: true,
    status: "async_launched",
    agentId: "a6fde93a0057787f9",
    description: "Census panel open/close call sites",
    resolvedModel: "claude-haiku-4-5-20251001",
    prompt: "In the repo …, I need a complete census…",
    outputFile: OUTPUT_FILE,
    canReadOutputFile: true,
  },
});

const TEAMMATE_STUB_LINE = JSON.stringify({
  parentUuid: "397196ec-9a50-4f96-a3fa-7e1180615527",
  isSidechain: false,
  promptId: "4bb6ef7c-ea4b-4a53-87d2-6121f436eac3",
  type: "user",
  message: {
    role: "user",
    content: [{
      tool_use_id: "toolu_01EnDjLeF25mSTDADtwJn9VX",
      type: "tool_result",
      content: [{ type: "text", text: "Spawned successfully. (This tool result is internal metadata — never quote or paste any part of it, including the ID below, into a user-facing reply.)\nagent_id: transcript-hunter@session-a7893ee8\nname: transcript-hunter\nThe agent is now running and will receive instructions via mailbox." }],
    }],
  },
  uuid: "8026d788-5a69-4fc2-ba1d-7679110b3898",
  timestamp: "2026-07-04T18:18:05.330Z",
  toolUseResult: {
    status: "teammate_spawned",
    prompt: "Strictly read-only investigation…",
    teammate_id: "transcript-hunter@session-a7893ee8",
    agent_id: "transcript-hunter@session-a7893ee8",
    agent_type: "Explore",
    model: "opus",
    name: "transcript-hunter",
    color: "blue",
    tmux_session_name: "in-process",
    tmux_window_name: "in-process",
    tmux_pane_id: "in-process",
    team_name: "session-a7893ee8",
    is_splitpane: false,
    plan_mode_required: false,
  },
});

const FINAL_RESULT = "Perfect! Now I have all the information needed. Let me compile the comprehensive census:\n\n## Right-Panel Docked Viewers: Complete Census\n\n### 1. FILE VIEWER\n…";
const CARRIER_XML = `<task-notification>\n<task-id>a6fde93a0057787f9</task-id>\n<tool-use-id>toolu_018qvuRQcebp39TA5CYUq6zV</tool-use-id>\n<output-file>${OUTPUT_FILE}</output-file>\n<status>completed</status>\n<summary>Agent "Census panel open/close call sites" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>${FINAL_RESULT}</result>\n</task-notification>`;

const QUEUE_OP_LINE = JSON.stringify({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: "2026-07-04T14:43:16.424Z",
  sessionId: "1fbb295a-4f62-4a6f-8532-c456e607e5e1",
  content: CARRIER_XML,
});

const QUEUED_CMD_LINE = JSON.stringify({
  parentUuid: "337525bf-adc8-4e0b-bdce-077ff13456a0",
  isSidechain: false,
  type: "attachment",
  attachment: { type: "queued_command", commandMode: "prompt", prompt: CARRIER_XML, timestamp: "2026-07-04T14:43:16.500Z" },
  uuid: "5b2b74a4-0000-4000-8000-000000000000",
  timestamp: "2026-07-04T14:43:16.500Z",
});

const FOREGROUND_LINE = JSON.stringify({
  parentUuid: "8a5bfcf6-f734-4694-9720-98ce1b71eeea",
  isSidechain: false,
  promptId: "4bb6ef7c-ea4b-4a53-87d2-6121f436eac3",
  type: "user",
  message: {
    role: "user",
    content: [{
      tool_use_id: "toolu_01134Bw9dHCgp4ueo5JNTFuC",
      type: "tool_result",
      content: "I've hit a hard limitation I need to report honestly rather than guess further.\n\n## Findings\n…",
    }],
  },
  uuid: "548ab85d-1b82-4bb0-a424-6c9bf77ee028",
  timestamp: "2026-07-04T18:26:23.793Z",
  toolUseResult: {
    status: "completed",
    prompt: "List all files in the directory …",
    agentId: "a1ca03c350540fb02",
    agentType: "Explore",
    content: [{ type: "text", text: "I've hit a hard limitation…" }],
    resolvedModel: "claude-opus-4-8",
    totalDurationMs: 85943,
    totalTokens: 28972,
    totalToolUseCount: 20,
  },
});

describe("subagent_started — async launch stub", () => {
  it("emits started with correlation + enrichment (after the spawning tool_use)", () => {
    const evs = collect([BG_TOOL_USE_LINE, BG_STUB_LINE]);
    const started = ofKind(evs, "subagent_started");
    assert.equal(started.length, 1);
    const p = started[0].payload;
    assert.equal(p.toolUseId, "toolu_018qvuRQcebp39TA5CYUq6zV");
    assert.equal(p.agentId, "a6fde93a0057787f9");
    assert.equal(p.background, true);
    assert.equal(p.description, "Census panel open/close call sites");
    assert.equal(p.agentType, "Explore");
    assert.equal(p.outputFile, OUTPUT_FILE);
  });

  it("keeps the stub's regular tool_result emission unchanged", () => {
    const evs = collect([BG_STUB_LINE]);
    const results = ofKind(evs, "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0].payload.toolUseId, "toolu_018qvuRQcebp39TA5CYUq6zV");
    assert.match(String(results[0].payload.text), /^Async agent launched successfully\./);
  });

  it("works without the spawning tool_use in state (description from toolUseResult)", () => {
    const evs = collect([BG_STUB_LINE]);
    const started = ofKind(evs, "subagent_started");
    assert.equal(started.length, 1);
    assert.equal(started[0].payload.description, "Census panel open/close call sites");
    assert.equal(started[0].payload.agentType, undefined);
  });
});

describe("subagent_started — named-agent (teammate) stub", () => {
  it("emits started from the teammate_spawned toolUseResult", () => {
    const evs = collect([TEAMMATE_STUB_LINE]);
    const started = ofKind(evs, "subagent_started");
    assert.equal(started.length, 1);
    const p = started[0].payload;
    assert.equal(p.toolUseId, "toolu_01EnDjLeF25mSTDADtwJn9VX");
    assert.equal(p.agentId, "transcript-hunter@session-a7893ee8");
    assert.equal(p.background, true);
    assert.equal(p.agentType, "Explore");
    assert.equal(p.outputFile, undefined);
  });
});

describe("subagent_completed — task-notification carrier", () => {
  it("emits exactly one completion across the queue-operation + queued_command pair", () => {
    const evs = collect([BG_STUB_LINE, QUEUE_OP_LINE, QUEUED_CMD_LINE]);
    const completed = ofKind(evs, "subagent_completed");
    assert.equal(completed.length, 1);
    const p = completed[0].payload;
    assert.equal(p.agentId, "a6fde93a0057787f9");
    assert.equal(p.toolUseId, "toolu_018qvuRQcebp39TA5CYUq6zV");
    assert.equal(p.status, "completed");
    assert.equal(p.result, FINAL_RESULT);
    assert.equal(p.outputFile, OUTPUT_FILE);
  });

  it("dedupes when the attachment duplicate arrives first", () => {
    const evs = collect([QUEUED_CMD_LINE, QUEUE_OP_LINE]);
    assert.equal(ofKind(evs, "subagent_completed").length, 1);
  });

  it("maps killed → stopped and passes failed through", () => {
    for (const [xmlStatus, want] of [["killed", "stopped"], ["failed", "failed"], ["stopped", "stopped"]] as const) {
      const line = QUEUE_OP_LINE.replace("<status>completed</status>", `<status>${xmlStatus}</status>`);
      const evs = collect([line]);
      assert.equal(ofKind(evs, "subagent_completed")[0].payload.status, want, xmlStatus);
    }
  });

  it("skips non-terminal notifications without consuming the dedupe slot", () => {
    const running = QUEUE_OP_LINE.replace("<status>completed</status>", "<status>running</status>");
    const evs = collect([running, QUEUE_OP_LINE]);
    const completed = ofKind(evs, "subagent_completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].payload.status, "completed");
  });

  it("skips Monitor-event notifications (no status / tool-use-id / result)", () => {
    const monitor = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-04T15:00:00.000Z",
      sessionId: "1fbb295a-4f62-4a6f-8532-c456e607e5e1",
      content: "<task-notification>\n<task-id>bywy11jra</task-id>\n<summary>Monitor event: \"device pairing\"</summary>\n<event>[harness] remote device live</event>\n</task-notification>",
    });
    assert.equal(collect([monitor]).length, 0);
  });

  it("falls back to the stub's callId↔agentId map when the carrier lacks a task-id", () => {
    const noTaskId = QUEUE_OP_LINE.replace("<task-id>a6fde93a0057787f9</task-id>\\n", "");
    const evs = collect([BG_STUB_LINE, noTaskId]);
    const completed = ofKind(evs, "subagent_completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].payload.agentId, "a6fde93a0057787f9");
  });

  it("derives agentId from the output_file basename as last resort", () => {
    const noTaskId = QUEUE_OP_LINE.replace("<task-id>a6fde93a0057787f9</task-id>\\n", "");
    const evs = collect([noTaskId]); // fresh state — no stub seen
    const completed = ofKind(evs, "subagent_completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].payload.agentId, "a6fde93a0057787f9");
  });

  it("skips (never invents) when no agentId is derivable", () => {
    const bare = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      content: "<task-notification>\n<status>completed</status>\n<result>done</result>\n</task-notification>",
    });
    assert.equal(collect([bare]).length, 0);
  });
});

describe("foreground subagent — byte-identical behavior", () => {
  it("emits only the tool_result, no subagent events", () => {
    const evs = collect([FOREGROUND_LINE]);
    assert.equal(evs.length, 1);
    const p = evs[0].payload;
    assert.equal(p.kind, "tool_result");
    assert.equal(p.toolUseId, "toolu_01134Bw9dHCgp4ueo5JNTFuC");
    assert.equal(ofKind(evs, "subagent_started").length, 0);
    assert.equal(ofKind(evs, "subagent_completed").length, 0);
  });
});

describe("canonical mapping — matches the landed contract schema", () => {
  const roundtrip = (lines: string[]): unknown[] => {
    const canonical: unknown[] = [];
    const state = createSubagentParseState();
    for (const line of lines) {
      parseJsonlLine(line, (type, payload) => {
        for (const ev of toCanonicalEvents(type, payload)) canonical.push(AgentEventSchema.parse(ev));
      }, "opus", state);
    }
    return canonical;
  };

  it("subagent_started validates and carries every field", () => {
    const evs = roundtrip([BG_TOOL_USE_LINE, BG_STUB_LINE]) as Array<Record<string, unknown>>;
    const started = evs.find((e) => e.type === "subagent_started");
    assert.deepEqual(started, {
      type: "subagent_started",
      callId: "toolu_018qvuRQcebp39TA5CYUq6zV",
      agentId: "a6fde93a0057787f9",
      background: true,
      agentType: "Explore",
      description: "Census panel open/close call sites",
      outputFile: OUTPUT_FILE,
    });
  });

  it("subagent_completed validates and carries the full result", () => {
    const evs = roundtrip([QUEUE_OP_LINE, QUEUED_CMD_LINE]) as Array<Record<string, unknown>>;
    const completed = evs.filter((e) => e.type === "subagent_completed");
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0], {
      type: "subagent_completed",
      agentId: "a6fde93a0057787f9",
      callId: "toolu_018qvuRQcebp39TA5CYUq6zV",
      status: "completed",
      result: FINAL_RESULT,
      outputFile: OUTPUT_FILE,
    });
  });
});
