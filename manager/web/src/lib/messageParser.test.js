import { describe, it, expect } from "vitest";
import { buildBlocks, buildSummary, buildWorkerSummary, gitActions, applyRewinds, applyClears, sortBlocksByTs } from "./messageParser.js";

function agentRow(id, ts) {
  return { type: "jsonl", ts, payload: { kind: "tool_use", id, name: "Agent", input: { description: id } } };
}

function toolRunning(toolUseId, ts, parentAgentToolUseId) {
  const payload = { toolName: "Bash", toolUseId, input: { command: "echo" } };
  if (parentAgentToolUseId) payload.parentAgentToolUseId = parentAgentToolUseId;
  return { type: "tool_running", ts, payload };
}

function toolsOf(blocks, agentToolUseId) {
  const run = blocks.find((b) => b.kind === "agentRun" && b.toolUseId === agentToolUseId);
  return (run?.tools ?? []).map((t) => t.id);
}

describe("buildBlocks subagent attribution", () => {
  it("attributes deterministically by parentAgentToolUseId for overlapping spans", () => {
    // Two concurrent Agents whose spans overlap (no tool_result -> endTs=Infinity).
    // Inner Bash tools at ts 200/201 both fall inside both spans, so the old
    // timestamp window assigns both to idA (insertion order). parentAgentToolUseId
    // must split them.
    const events = [
      agentRow("idA", 100),
      agentRow("idB", 101),
      toolRunning("tA", 200, "idA"),
      toolRunning("tB", 201, "idB"),
    ];
    const blocks = buildBlocks(events);
    expect(toolsOf(blocks, "idA")).toEqual(["tA"]);
    expect(toolsOf(blocks, "idB")).toEqual(["tB"]);
    // No top-level tool stream leak.
    expect(blocks.some((b) => b.kind === "tool" && (b.tool.id === "tA" || b.tool.id === "tB"))).toBe(false);
  });

  it("falls back to the timestamp window when parentAgentToolUseId is absent", () => {
    const events = [
      agentRow("idA", 100),
      agentRow("idB", 101),
      toolRunning("tA", 200),
      toolRunning("tB", 201),
    ];
    const blocks = buildBlocks(events);
    const attributed = [...toolsOf(blocks, "idA"), ...toolsOf(blocks, "idB")];
    // Every inner tool lands under exactly one agentRun, and none leak to the
    // top-level tool stream.
    expect(attributed.sort()).toEqual(["tA", "tB"]);
    expect(blocks.some((b) => b.kind === "tool" && (b.tool.id === "tA" || b.tool.id === "tB"))).toBe(false);
  });
});

function mainToolUse(id, ts, name = "Read") {
  return { type: "jsonl", ts, payload: { kind: "tool_use", id, name, input: { file_path: "/x" } } };
}

function mainToolResult(toolUseId, ts, text) {
  return { type: "jsonl", ts, payload: { kind: "tool_result", toolUseId, text, isError: false } };
}

function mainToolDone(toolUseId, ts, result, toolName = "Read") {
  return { type: "tool_done", ts, payload: { toolName, toolUseId, result } };
}

function mainTool(blocks, id) {
  for (const b of blocks) {
    if (b.kind === "tool" && b.tool.id === id) return b.tool;
    if (b.kind === "toolGroup") {
      const t = b.tools.find((x) => x.id === id);
      if (t) return t;
    }
  }
  return null;
}

describe("buildBlocks skill_body attachment", () => {
  const skillUse = (id, ts) => ({ type: "jsonl", ts, payload: { kind: "tool_use", id, name: "Skill", input: { skill: "demo" } } });
  const skillBody = (toolUseId, ts, text) => ({ type: "jsonl", ts, payload: { kind: "skill_body", toolUseId, text } });

  it("attaches the injected body to its Skill tool by id", () => {
    const blocks = buildBlocks([skillUse("S1", 100), skillBody("S1", 101, "# Demo\nbody")]);
    expect(mainTool(blocks, "S1").skillBody).toBe("# Demo\nbody");
  });

  it("leaves skillBody undefined when no body event arrives", () => {
    const blocks = buildBlocks([skillUse("S1", 100)]);
    expect(mainTool(blocks, "S1").skillBody).toBeUndefined();
  });

  it("extracts skillPath from the injected base-directory line and cleans the body", () => {
    const text = "Base directory for this skill: /s/demo\n\n# Demo\nbody";
    const blocks = buildBlocks([skillUse("S1", 100), skillBody("S1", 101, text)]);
    const t = mainTool(blocks, "S1");
    expect(t.skillPath).toBe("/s/demo");
    expect(t.skillBody).toBe("# Demo\nbody");
  });

  it("attaches a null skillPath when the body has no base-directory line", () => {
    const blocks = buildBlocks([skillUse("S1", 100), skillBody("S1", 101, "# Demo\nbody")]);
    expect(mainTool(blocks, "S1").skillPath).toBeNull();
  });
});

describe("ask_peer peer name linking", () => {
  const askPeer = (toolUseId, peerId, ts) => ({
    type: "tool_running", ts,
    payload: { toolName: "mcp__worker__ask_peer", toolUseId, input: { peerId, question: "help?" } },
  });
  const peerConsult = (toWorker, toName, ts) => ({
    type: "peer_consult", ts, payload: { requestId: "r1", toWorker, toName, question: "help?" },
  });

  // The reported bug: a killed peer drops out of the live list, so the ask_peer
  // header must carry the peer name the parser linked from the peer_consult event.
  it("links the consulted peer's durable name onto the ask_peer tool", () => {
    const blocks = buildBlocks([askPeer("ap1", "w2", 100), peerConsult("w2", "domain-expert", 101)]);
    expect(mainTool(blocks, "ap1").peerTo).toEqual({ id: "w2", name: "domain-expert" });
  });

  it("leaves peerTo unset without a peer_consult event (falls back to live)", () => {
    const blocks = buildBlocks([askPeer("ap1", "w2", 100)]);
    expect(mainTool(blocks, "ap1").peerTo).toBeUndefined();
  });

  it("does not mislink a consult addressed to a different peer", () => {
    const blocks = buildBlocks([askPeer("ap1", "w2", 100), peerConsult("w9", "other", 101)]);
    expect(mainTool(blocks, "ap1").peerTo).toBeUndefined();
  });
});

describe("buildBlocks main-agent tool_done fallback", () => {
  it("clears a stuck-running tool when its tool_result jsonl is missing but tool_done fired", () => {
    const events = [
      mainToolUse("T1", 100),
      mainToolUse("T2", 101),
      mainToolResult("T1", 102, "T1 jsonl"),
      mainToolDone("T1", 103, "T1 hook"),
      mainToolDone("T2", 104, "T2 hook"),
    ];
    const blocks = buildBlocks(events);
    const t2 = mainTool(blocks, "T2");
    expect(t2.done).toBe(true);
    expect(t2.result).toEqual({ text: "T2 hook", isError: false });
  });

  it("keeps the jsonl tool_result when both it and tool_done are present", () => {
    const events = [
      mainToolUse("T1", 100),
      mainToolResult("T1", 101, "jsonl text"),
      mainToolDone("T1", 102, "hook text"),
    ];
    const blocks = buildBlocks(events);
    const t1 = mainTool(blocks, "T1");
    expect(t1.result.text).toBe("jsonl text");
    expect(t1.done).toBe(true);
  });

  it("leaves a tool running when neither tool_result jsonl nor tool_done is present", () => {
    const events = [mainToolUse("T1", 100)];
    const blocks = buildBlocks(events);
    const t1 = mainTool(blocks, "T1");
    expect(t1.result).toBe(null);
    expect(t1.done).toBe(false);
    expect(t1.running).toBe(true);
  });

  it("marks a failed tool_done (PostToolUseFailure) result as error", () => {
    const events = [
      mainToolUse("T1", 100),
      { type: "tool_done", ts: 101, payload: { toolName: "Read", toolUseId: "T1", result: "boom", isError: true } },
    ];
    const t1 = mainTool(buildBlocks(events), "T1");
    expect(t1.running).toBe(false);
    expect(t1.result).toEqual({ text: "boom", isError: true });
  });

  it("lets attachAskUserAnswers win over a present tool_done", () => {
    const events = [
      mainToolUse("Q1", 100, "AskUserQuestion"),
      mainToolDone("Q1", 101, "hook text", "AskUserQuestion"),
      { type: "user_message", ts: 102, payload: { text: "My answers to your questions: yes" } },
    ];
    const blocks = buildBlocks(events);
    const q1 = mainTool(blocks, "Q1");
    expect(q1.done).toBe(true);
    expect(q1.running).toBe(false);
    expect(q1.result.text.startsWith("My answers to your questions:")).toBe(true);
  });
});

describe("buildBlocks lifecycle barriers", () => {
  const stop = (ts) => ({ type: "hook", ts, payload: { event: "Stop" } });
  const idle = (ts, reason) => ({ type: "state", ts, payload: { state: "IDLE", from: "WORKING", reason } });
  const exit = (ts) => ({ type: "exit", ts, payload: { code: 143 } });

  it("closes a tool with no terminal signal once the turn ends (Stop)", () => {
    const t1 = mainTool(buildBlocks([mainToolUse("T1", 100), stop(101)]), "T1");
    expect(t1.running).toBe(false);
    expect(t1.result).toBe(null); // closed, not faked as succeeded
  });

  it("closes a tool when the worker goes IDLE via interrupt", () => {
    const t1 = mainTool(buildBlocks([mainToolUse("T1", 100), idle(101, "interrupt")]), "T1");
    expect(t1.running).toBe(false);
  });

  it("closes a hook-only (tool_running) tool on worker exit", () => {
    const events = [
      { type: "tool_running", ts: 100, payload: { toolName: "Bash", toolUseId: "B1", input: {} } },
      exit(101),
    ];
    const b1 = mainTool(buildBlocks(events), "B1");
    expect(b1.running).toBe(false);
  });

  it("keeps a tool running when the barrier precedes it", () => {
    const t1 = mainTool(buildBlocks([stop(99), mainToolUse("T1", 100)]), "T1");
    expect(t1.running).toBe(true);
  });

  it("keeps background-agent inner tools running across a turn end", () => {
    const events = [
      agentRow("AG", 100),
      mainToolResult("AG", 101, "Async agent launched successfully"),
      toolRunning("I1", 102, "AG"),
      stop(103),
    ];
    const run = buildBlocks(events).find((b) => b.kind === "agentRun");
    expect(run.status).toBe("running");
    expect(run.tools[0].running).toBe(true);
  });

  it("closes a background agent and its inner tools on worker exit", () => {
    const events = [
      agentRow("AG", 100),
      mainToolResult("AG", 101, "Async agent launched successfully"),
      toolRunning("I1", 102, "AG"),
      exit(103),
    ];
    const run = buildBlocks(events).find((b) => b.kind === "agentRun");
    expect(run.status).toBe("completed");
    expect(run.tools[0].running).toBe(false);
  });

  it("completes a background agent when all inner tools are done", () => {
    const events = [
      agentRow("AG", 100),
      mainToolResult("AG", 101, "Async agent launched successfully"),
      toolRunning("I1", 102, "AG"),
      mainToolDone("I1", 103, "ok", "Bash"),
    ];
    const run = buildBlocks(events).find((b) => b.kind === "agentRun");
    expect(run.status).toBe("completed");
  });

  it("closes a foreground agent killed mid-run", () => {
    const events = [agentRow("AG", 100), exit(101)];
    const run = buildBlocks(events).find((b) => b.kind === "agentRun");
    expect(run.status).toBe("completed");
  });
});

describe("buildBlocks standalone tools", () => {
  it("keeps standalone tools out of toolGroups and splits the surrounding group", () => {
    const events = [
      mainToolUse("T1", 100),
      mainToolUse("T2", 101),
      mainToolUse("S1", 102, "Skill"),
      mainToolUse("T3", 103),
      mainToolUse("T4", 104),
    ];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["toolGroup", "tool", "toolGroup"]);
    expect(blocks[0].tools.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(blocks[1].tool.id).toBe("S1");
    expect(blocks[2].tools.map((t) => t.id)).toEqual(["T3", "T4"]);
  });

  it("renders a standalone tool alone even between groupable tools from tool_running events", () => {
    const events = [
      { type: "tool_running", ts: 100, payload: { toolName: "Bash", toolUseId: "B1", input: {} } },
      { type: "tool_running", ts: 101, payload: { toolName: "AskUserQuestion", toolUseId: "Q1", input: {} } },
      { type: "tool_running", ts: 102, payload: { toolName: "Bash", toolUseId: "B2", input: {} } },
    ];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "tool", "tool"]);
    expect(blocks[1].tool.name).toBe("AskUserQuestion");
  });

  it("keeps a hook-only Agent (transcript not yet flushed) out of toolGroups", () => {
    const events = [
      { type: "tool_running", ts: 100, payload: { toolName: "Bash", toolUseId: "B1", input: {} } },
      { type: "tool_running", ts: 101, payload: { toolName: "Agent", toolUseId: "A1", input: {} } },
      { type: "tool_running", ts: 102, payload: { toolName: "Bash", toolUseId: "B2", input: {} } },
    ];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["tool", "tool", "tool"]);
    expect(blocks[1].tool.name).toBe("Agent");
  });
});

describe("buildBlocks worker-tool lane", () => {
  const kill = (id, ts) => mainToolUse(id, ts, "mcp__orchestrator__kill_worker");
  const spawn = (id, ts) => mainToolUse(id, ts, "mcp__orchestrator__spawn_worker");

  it("collapses consecutive worker tools into one group with a worker summary", () => {
    const blocks = buildBlocks([kill("K1", 100), kill("K2", 101), kill("K3", 102)]);
    expect(blocks.map((b) => b.kind)).toEqual(["toolGroup"]);
    expect(blocks[0].lane).toBe("worker");
    expect(blocks[0].tools.map((t) => t.id)).toEqual(["K1", "K2", "K3"]);
    expect(blocks[0].summary).toBe("Killed 3 workers");
  });

  it("summarizes mixed worker tools per verb in first-appearance order", () => {
    const blocks = buildBlocks([spawn("S1", 100), spawn("S2", 101), kill("K1", 102)]);
    expect(blocks.map((b) => b.kind)).toEqual(["toolGroup"]);
    expect(blocks[0].summary).toBe("Spawned 2 workers, killed 1 worker");
  });

  it("does not merge worker tools into a generic group — a lane change splits the run", () => {
    const events = [mainToolUse("T1", 100), mainToolUse("T2", 101), kill("K1", 102), kill("K2", 103), mainToolUse("T3", 104)];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["toolGroup", "toolGroup", "tool"]);
    expect(blocks[0].lane).toBe("generic");
    expect(blocks[1].lane).toBe("worker");
    expect(blocks[1].tools.map((t) => t.id)).toEqual(["K1", "K2"]);
    expect(blocks[2].tool.id).toBe("T3");
  });

  it("keeps a lone worker tool as a standalone tool block", () => {
    const blocks = buildBlocks([kill("K1", 100)]);
    expect(blocks.map((b) => b.kind)).toEqual(["tool"]);
    expect(blocks[0].tool.id).toBe("K1");
  });

  it("phrases noun-less worker tools with ×n", () => {
    const t = (name) => ({ name });
    expect(buildWorkerSummary([t("mcp__orchestrator__list_workers"), t("mcp__orchestrator__list_workers")])).toBe("Listed workers ×2");
    expect(buildWorkerSummary([t("mcp__orchestrator__get_worker"), t("mcp__orchestrator__list_pending_permissions")]))
      .toBe("Checked 1 worker, checked pending permissions");
  });

  it("groups worker tools arriving via tool_running events", () => {
    const events = [
      { type: "tool_running", ts: 100, payload: { toolName: "mcp__orchestrator__kill_worker", toolUseId: "K1", input: {} } },
      { type: "tool_running", ts: 101, payload: { toolName: "mcp__orchestrator__kill_worker", toolUseId: "K2", input: {} } },
    ];
    const blocks = buildBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["toolGroup"]);
    expect(blocks[0].lane).toBe("worker");
    expect(blocks[0].summary).toBe("Killed 2 workers");
  });
});

function bashTool(command, resultText, isError = false) {
  return {
    name: "Bash",
    verb: "bash",
    input: { command },
    result: resultText != null ? { text: resultText, isError } : null,
  };
}

describe("gitActions", () => {
  it("maps git mutation subcommands to past-tense verbs", () => {
    expect(gitActions(bashTool("git push origin dev")).map((a) => a.verb)).toEqual(["Pushed"]);
    expect(gitActions(bashTool("git merge feature-x")).map((a) => a.verb)).toEqual(["Merged"]);
    expect(gitActions(bashTool("cd /x && git -C /y rebase main")).map((a) => a.verb)).toEqual(["Rebased"]);
  });

  it("handles compound commands with multiple git actions", () => {
    const verbs = gitActions(bashTool('git add -A && git commit -m "x" && git push')).map((a) => a.verb);
    expect(verbs).toEqual(["Staged", "Committed", "Pushed"]);
  });

  it("treats read-only git commands as non-actions", () => {
    expect(gitActions(bashTool("git status && git log --oneline"))).toEqual([]);
  });

  it("maps git diff to Viewed diff", () => {
    expect(gitActions(bashTool("git diff main..dev")).map((a) => a.verb)).toEqual(["Viewed diff"]);
  });

  it("ignores git words inside quoted strings", () => {
    expect(gitActions(bashTool('echo "run git push later"'))).toEqual([]);
    expect(gitActions(bashTool('git commit -m "git merge notes"')).map((a) => a.sub)).toEqual(["commit"]);
  });

  it("extracts commit shas from the result text", () => {
    const t = bashTool('git commit -m "msg"', "[dev fbce36a] msg\n 1 file changed");
    expect(gitActions(t)[0].shas).toEqual(["fbce36a"]);
  });

  it("returns no actions for failed commands", () => {
    expect(gitActions(bashTool("git push", "rejected", true))).toEqual([]);
  });

  it("strips flags and redirections from the detail", () => {
    const a = gitActions(bashTool("git push -u origin dev 2>&1"))[0];
    expect(a.detail).toBe("origin dev");
  });
});

describe("buildSummary git awareness", () => {
  it("verbs git bash tools and counts the rest as shell commands", () => {
    const tools = [
      { name: "Read", verb: "read", input: {} },
      bashTool('git commit -m "x"', "[dev abc1234] x"),
      bashTool("git push"),
      bashTool("npm test"),
    ];
    expect(buildSummary(tools)).toBe("Read 1 file, Committed abc1234, Pushed, ran 1 shell command");
  });

  it("merges shas from multiple commits and dedupes verbs", () => {
    const tools = [
      bashTool('git commit -m "a"', "[dev aaa1111] a"),
      bashTool('git commit -m "b"', "[dev bbb2222] b"),
    ];
    expect(buildSummary(tools)).toBe("Committed aaa1111, bbb2222");
  });

  it("keeps plain shell-only groups as shell commands", () => {
    const tools = [bashTool("ls"), bashTool("npm run build")];
    expect(buildSummary(tools)).toBe("ran 2 shell commands");
  });

  it("counts repeated git verbs across the group", () => {
    const tools = [
      bashTool("git diff a.ts"),
      bashTool("git diff b.ts && git diff c.ts && git diff d.ts"),
      bashTool("git diff e.ts f.ts"),
    ];
    expect(buildSummary(tools)).toBe("Viewed 5 diffs");
  });
});

describe("applyRewinds", () => {
  const user = (text, ts) => ({ type: "user_message", ts, payload: JSON.stringify({ text }) });
  const asst = (text, ts) => ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "assistant_text", text }) });
  const rewound = (payload, ts) => ({ type: "conversation_rewound", ts, payload: JSON.stringify(payload) });

  it("passes through when no rewind events exist", () => {
    const events = [user("hello", 1), asst("hi", 2)];
    expect(applyRewinds(events)).toEqual(events);
  });

  it("cuts from the matching user message (it returns to the composer)", () => {
    const events = [
      user("first", 1),
      asst("r1", 2),
      user("second", 3),
      asst("r2", 4),
      rewound({ text: "second", display: "second", index: 1 }, 5),
    ];
    expect(applyRewinds(events).map((e) => e.ts)).toEqual([1, 2]);
  });

  it("matches the LAST occurrence when texts repeat", () => {
    const events = [
      user("same", 1),
      asst("r1", 2),
      user("same", 3),
      asst("r2", 4),
      rewound({ text: "same", display: "same", index: 1 }, 5),
    ];
    expect(applyRewinds(events).map((e) => e.ts)).toEqual([1, 2]);
  });

  it("tolerates attachment suffixes via either-way prefix match", () => {
    const events = [
      user("fix the bug [Image #1]", 1),
      asst("done", 2),
      rewound({ text: "fix the bug", display: "fix the bug", index: 0 }, 3),
    ];
    expect(applyRewinds(events)).toEqual([]);
  });

  it("falls back to index when texts don't match (action prompts)", () => {
    const events = [
      user("hello", 1),
      asst("hi", 2),
      user("/commit", 3), // displayText — the transcript holds the full template
      asst("committed", 4),
      rewound({ text: "FULL COMMIT TEMPLATE …", display: "FULL COMMIT TEMPLATE …", index: 1 }, 5),
    ];
    expect(applyRewinds(events).map((e) => e.ts)).toEqual([1, 2]);
  });

  it("applies bootPromptOffset for prompts with no event", () => {
    // Active branch: [boot prompt (no event), "hello"] → index 1 = first event prompt
    const events = [
      user("hello", 1),
      asst("hi", 2),
      rewound({ text: "NO MATCH", display: "NO MATCH", index: 1 }, 3),
    ];
    expect(applyRewinds(events, { bootPromptOffset: 1 })).toEqual([]);
  });

  it("hides nothing when no cut point is found", () => {
    const events = [
      user("hello", 1),
      rewound({ text: "NO MATCH", display: "NO MATCH" }, 2),
    ];
    expect(applyRewinds(events)).toEqual([events[0]]);
  });

  it("supports sequential rewinds (each cuts the then-active branch)", () => {
    const events = [
      user("a", 1),
      asst("ra", 2),
      user("b", 3),
      asst("rb", 4),
      rewound({ text: "b", display: "b", index: 1 }, 5),
      user("b2", 6),
      asst("rb2", 7),
      rewound({ text: "b2", display: "b2", index: 1 }, 8),
    ];
    expect(applyRewinds(events).map((e) => e.ts)).toEqual([1, 2]);
  });
});

describe("applyClears", () => {
  const user = (text, ts) => ({ type: "user_message", ts, payload: JSON.stringify({ text }) });
  const asst = (text, ts) => ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "assistant_text", text }) });
  const cleared = (ts) => ({ type: "conversation_cleared", ts, payload: JSON.stringify({}) });

  it("passes through when no clear marker exists", () => {
    const events = [user("hello", 1), asst("hi", 2)];
    expect(applyClears(events)).toEqual(events);
  });

  it("drops everything before the marker, keeps the marker itself", () => {
    const events = [user("/clear", 1), asst("old", 2), cleared(3), user("fresh", 4)];
    expect(applyClears(events).map((e) => e.ts)).toEqual([3, 4]);
  });

  it("cuts at the LAST marker when cleared repeatedly", () => {
    const events = [user("a", 1), cleared(2), user("b", 3), cleared(4), user("c", 5)];
    expect(applyClears(events).map((e) => e.ts)).toEqual([4, 5]);
  });

  it("renders the marker as a divider block via buildBlocks", () => {
    const blocks = buildBlocks(applyClears([user("old", 1), cleared(2), user("new", 3)]));
    expect(blocks.map((b) => b.kind)).toEqual(["cleared", "user"]);
  });
});

describe("chat ordering (sentAt + sortBlocksByTs)", () => {
  const thinking = (text, ts) => ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "thinking", text }) });
  const asst = (text, ts) => ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "assistant_text", text }) });
  const userAt = (text, ts, sentAt) => ({ type: "user_message", ts, payload: JSON.stringify({ text, sentAt }) });

  it("user block ts prefers payload.sentAt over the event row ts", () => {
    const blocks = buildBlocks([userAt("hi", 500, 100)]);
    expect(blocks[0]).toMatchObject({ kind: "user", ts: 100 });
  });

  it("user block ts falls back to event ts without sentAt", () => {
    const blocks = buildBlocks([{ type: "user_message", ts: 500, payload: JSON.stringify({ text: "hi" }) }]);
    expect(blocks[0].ts).toBe(500);
  });

  it("moves a late-emitted user bubble above the output it caused", () => {
    // Append order: the turn's thinking/text rows landed before the
    // user_message row (delivery_unverified emits at resolution) — sentAt
    // predates them, so the bubble sorts back above.
    const events = [thinking("hmm", 200), asst("out", 210), userAt("do it", 300, 150)];
    const blocks = sortBlocksByTs(buildBlocks(events));
    expect(blocks.map((b) => b.kind)).toEqual(["user", "thinking", "assistant"]);
  });

  it("keeps same-ts blocks in their original relative order", () => {
    const events = [thinking("a", 100), asst("b", 100), userAt("c", 100, 100)];
    const before = buildBlocks(events).map((b) => b.kind);
    const after = sortBlocksByTs(buildBlocks(events)).map((b) => b.kind);
    expect(after).toEqual(before);
  });
});

describe("creation-domain ordering (tsTranscript / anchorTs)", () => {
  // ev.ts = daemon receipt time; tsTranscript/anchorTs = transcript creation.
  const asstAt = (text, ts, tsTranscript) =>
    ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "assistant_text", text, tsTranscript }) });
  const userMsg = (text, ts, extra = {}) =>
    ({ type: "user_message", ts, payload: JSON.stringify({ text, ...extra }) });

  it("sorts a drained queue message AFTER the previous turn's trailing output", () => {
    // Turn 1's final text was created at 1000 but batch-flushed late (receipt
    // 2300). The drain dispatched at 2000 (sentAt) and the message's user_text
    // landed in the transcript at 2500 (anchorTs). Receipt/sentAt comparison
    // would flip them; creation-domain comparison must not.
    const events = [
      asstAt("final output", 2300, 1000),
      userMsg("queued msg", 2600, { sentAt: 2000, anchorTs: 2500 }),
    ];
    const blocks = sortBlocksByTs(buildBlocks(events));
    expect(blocks.map((b) => b.kind)).toEqual(["assistant", "user"]);
  });

  it("keeps the bubble above the output it caused (new turn, late flush)", () => {
    const events = [
      userMsg("go", 4000, { sentAt: 2000, anchorTs: 2500 }),
      asstAt("response", 4100, 3000),
    ];
    const blocks = sortBlocksByTs(buildBlocks(events));
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant"]);
  });

  it("assistant/thinking/tool blocks prefer tsTranscript over receipt ts", () => {
    const events = [
      { type: "jsonl", ts: 900, payload: JSON.stringify({ kind: "thinking", text: "t", tsTranscript: 500 }) },
      asstAt("a", 901, 510),
      { type: "jsonl", ts: 902, payload: JSON.stringify({ kind: "tool_use", id: "T1", name: "Read", input: {}, tsTranscript: 520 }) },
    ];
    const blocks = buildBlocks(events);
    expect(blocks.find((b) => b.kind === "thinking").ts).toBe(500);
    expect(blocks.find((b) => b.kind === "assistant").ts).toBe(510);
    expect(blocks.find((b) => b.kind === "tool").ts).toBe(520);
  });

  it("falls back anchorTs → sentAt → ev.ts on legacy rows", () => {
    const both = buildBlocks([userMsg("x", 300, { sentAt: 150, anchorTs: 250 })]);
    const sent = buildBlocks([userMsg("x", 300, { sentAt: 150 })]);
    const bare = buildBlocks([userMsg("x", 300)]);
    expect(both[0].ts).toBe(250);
    expect(sent[0].ts).toBe(150);
    expect(bare[0].ts).toBe(300);
  });

  it("report/directive blocks use the same anchor chain", () => {
    const rep = buildBlocks([{ type: "worker_report", ts: 300, payload: JSON.stringify({ text: "r", sentAt: 100, anchorTs: 200 }) }]);
    const dir = buildBlocks([{ type: "orchestrator_message", ts: 300, payload: JSON.stringify({ text: "d", sentAt: 100, anchorTs: 200 }) }]);
    expect(rep[0].ts).toBe(200);
    expect(dir[0].ts).toBe(200);
  });
});
