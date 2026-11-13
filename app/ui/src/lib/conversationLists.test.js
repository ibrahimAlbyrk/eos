import { describe, it, expect } from "vitest";
import { buildBlocks } from "./messageParser.js";
import { collectSubagents } from "./subagentRuns.js";
import { collectArtifacts } from "./artifactLink.js";
import { summarizeSubagent } from "./subagentSummary.js";
import { groupRuns, mergeArtifacts, mergeSubagents, subagentFromRows, summarizeAll } from "./conversationLists.js";

let id = 0;
const ev = (type, payload) => ({ id: ++id, ts: id * 10, type, payload: JSON.stringify(payload) });
const agent = (payload) => ev("agent_event", payload);
const launch = (callId, description) =>
  agent({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name: "Agent", spawnsSubagent: true, input: { description, prompt: "go" } }] });
const finish = (callId, content = "done") => agent({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId, content }] });
const inner = (callId, parent) => agent({ type: "activity", kind: "tool_started", callId, toolName: "Read", input: { file_path: `/w/${callId}` }, parentCallId: parent });
const started = (callId, agentId) => agent({ type: "subagent_started", callId, agentId });
const resume = (callId) => agent({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name: "SendMessage", input: { message: "more" } }] });
const publish = (callId, title, url) => [
  agent({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId, name: "Artifact", input: { title } }] }),
  finish(callId, `Published ${url}`),
];

const subagentsOf = (rows) => collectSubagents(buildBlocks(rows));
const strip = (list) => list.map(({ identity, runs, ...s }) => ({ ...s, runs: runs.map(({ identity: _, ...r }) => r) }));

describe("summarizeAll / groupRuns", () => {
  it("keeps each subagent's identity and groups runs as collectSubagents does", () => {
    id = 0;
    const rows = [launch("A", "first"), started("A", "ag-a"), finish("A"), launch("B", "second"), resume("S"), started("S", "ag-a")];
    const full = subagentsOf(rows);
    const summaries = summarizeAll(full);
    expect(summaries.map((s) => [s.toolUseId, s.runs.length, s.identity])).toEqual(full.map((s) => [s.toolUseId, s.runs.length, s.identity]));
    expect(strip(summaries)).toEqual(full.map(summarizeSubagent));
    expect(groupRuns(summaries.flatMap((s) => s.runs))).toEqual(summaries);
  });
});

describe("mergeSubagents", () => {
  it("lists the whole conversation, the window's runs taking over the ones it shows", () => {
    id = 0;
    const older = [launch("OLD", "old one"), finish("OLD"), launch("MID", "mid one")];
    const window = [inner("r1", "MID"), finish("MID", "report"), launch("NEW", "new one"), inner("r2", "NEW")];
    const whole = summarizeAll(subagentsOf([...older, ...window.slice(0, 2)]));
    const merged = mergeSubagents(whole, subagentsOf([older[2], ...window]));
    expect(merged.map((s) => [s.toolUseId, s.status, s.toolCount])).toEqual([["OLD", "completed", 0], ["MID", "completed", 1], ["NEW", "running", 1]]);
    expect(strip(merged)).toEqual(strip(summarizeAll(subagentsOf([...older, ...window]))));
    expect(merged.map((s) => s.identity)).toEqual(summarizeAll(subagentsOf([...older, ...window])).map((s) => s.identity));
  });

  it("joins a run the window shows to the subagent it continues, which only the summaries hold", () => {
    id = 0;
    const older = [launch("A", "Researcher"), started("A", "ag-a"), finish("A")];
    const window = [resume("S"), started("S", "ag-a"), inner("r1", "S")];
    const whole = summarizeAll(subagentsOf([...older, ...window.slice(0, 2)]));
    const merged = mergeSubagents(whole, subagentsOf(window));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ toolUseId: "A", description: "Researcher", status: "running", toolCount: 1 });
    expect(merged[0].runs.map((r) => [r.toolUseId, r.resumeOf, r.description])).toEqual([["A", null, "Researcher"], ["S", "A", "Researcher"]]);
  });
});

describe("mergeArtifacts", () => {
  it("keeps a page's first link and title and takes the window's latest activity", () => {
    id = 0;
    const url = "https://claude.ai/code/artifact/0b5e7a2c-1111-4222-8333-444455556666";
    const other = "https://claude.ai/code/artifact/0b5e7a2c-1111-4222-8333-444455556667";
    const older = [...publish("P1", "Notes", url), ...publish("P2", "Other", other)];
    const window = [...publish("P3", undefined, url)];
    const merged = mergeArtifacts(collectArtifacts(buildBlocks(older)), collectArtifacts(buildBlocks(window)));
    expect(merged).toEqual(collectArtifacts(buildBlocks([...older, ...window])));
    expect(merged.map((a) => [a.title, a.ts])).toEqual([["Notes", 50], ["Other", 30]]);
  });
});

describe("subagentFromRows", () => {
  it("rebuilds one subagent whole from its own rows", () => {
    id = 0;
    const rows = [launch("A", "only"), inner("r1", "A"), finish("A", "the report")];
    const one = subagentFromRows(rows, "A");
    expect(one).toMatchObject({ toolUseId: "A", result: "the report", prompt: "go" });
    expect(one.tools.map((t) => t.id)).toEqual(["r1"]);
    expect(subagentFromRows(rows, "missing")).toBeNull();
  });
});
