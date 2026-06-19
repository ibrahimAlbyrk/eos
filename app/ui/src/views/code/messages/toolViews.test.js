import { describe, it, expect } from "vitest";
import { getToolView } from "./toolViews.jsx";
import { GenericDetail } from "./ToolDetail.jsx";

describe("getToolView", () => {
  it("falls back to the generic view for unknown tools", () => {
    const v = getToolView("mcp__context7__query-docs");
    expect(v.Detail).toBe(GenericDetail);
    expect(v.label({ name: "mcp__context7__query-docs" })).toEqual({ verb: "Used", file: "mcp__context7__query-docs" });
    expect(v.runningLabel({ name: "mcp__context7__query-docs" })).toEqual({ verb: "Running", file: "mcp__context7__query-docs" });
    expect(v.filePath({ input: {} })).toBe(null);
    expect(v.stats({ input: {} })).toBe(null);
  });

  it("returns the same default view for any unregistered name", () => {
    expect(getToolView("foo").Detail).toBe(getToolView("bar").Detail);
    expect(getToolView(undefined).Detail).toBe(GenericDetail);
  });

  it("uses a bespoke Detail for known tools", () => {
    expect(getToolView("Read").Detail).not.toBe(GenericDetail);
  });

  it("builds Read labels from the file basename", () => {
    const read = getToolView("Read");
    const tool = { input: { file_path: "/a/b/c.ts" } };
    expect(read.label(tool)).toEqual({ verb: "Read", file: "c.ts" });
    expect(read.runningLabel(tool)).toEqual({ verb: "Reading", file: "c.ts" });
    expect(read.filePath(tool)).toBe("/a/b/c.ts");
  });

  it("computes Edit diff stats", () => {
    const stats = getToolView("Edit").stats({ input: { old_string: "a\nb", new_string: "a\nb\nc" } });
    expect(stats).toEqual({ add: 1, del: 0 });
  });

  it("resolves agentRef for send_message_to_parent from ctx.parent, null elsewhere", () => {
    const v = getToolView("mcp__worker__send_message_to_parent");
    expect(v.agentRef({}, { parent: { id: "w1", name: "orch" } })).toEqual({ id: "w1", name: "orch" });
    expect(v.agentRef({}, {})).toBe(null);
    expect(getToolView("Read").agentRef({}, {})).toBe(null);
  });

  it("summarizes git verbs for Bash, else Ran", () => {
    const bash = getToolView("Bash");
    expect(bash.label({ name: "Bash", input: { command: "git push origin dev" }, result: { isError: false } }).verb).toBe("Pushed");
    expect(bash.label({ name: "Bash", input: { command: "ls -la" } })).toEqual({ verb: "Ran", file: "ls -la" });
  });

  it("gives the peer tools bespoke views matching the worker-MCP design", () => {
    const ask = getToolView("mcp__worker__ask_peer");
    expect(ask.Detail).not.toBe(GenericDetail);
    expect(ask.label({ input: { peerId: "w-7" } })).toEqual({ verb: "Asked", file: "w-7" });
    expect(ask.runningLabel({ input: { peerId: "w-7" } })).toEqual({ verb: "Asking", file: "w-7" });
    // agentRef resolves the peer by id (AgentLink fills the name from workers)
    expect(ask.agentRef({ input: { peerId: "w-7" } })).toEqual({ id: "w-7", name: null });
    expect(ask.agentRef({ input: {} })).toBe(null);

    const respond = getToolView("mcp__worker__respond_to_peer");
    expect(respond.Detail).not.toBe(GenericDetail);
    // No asker known → generic "peer".
    expect(respond.label({})).toEqual({ verb: "Replied to", file: "peer" });
    expect(respond.agentRef({})).toBe(null);
    // Parser-linked asker (works for existing messages) wins.
    const linked = { peerTo: { id: "w-a", name: "peer-alice" } };
    expect(respond.label(linked)).toEqual({ verb: "Replied to", file: "peer-alice" });
    expect(respond.agentRef(linked)).toEqual({ id: "w-a", name: "peer-alice" });
    // Falls back to the daemon's JSON result when not linked.
    const answered = { result: { text: JSON.stringify({ delivered: true, toWorker: "w-b", toName: "peer-bob" }) } };
    expect(respond.label(answered)).toEqual({ verb: "Replied to", file: "peer-bob" });
    expect(respond.agentRef(answered)).toEqual({ id: "w-b", name: "peer-bob" });

    const list = getToolView("mcp__worker__list_peers");
    expect(list.Detail).not.toBe(GenericDetail);
    expect(list.label({})).toEqual({ verb: "Listed", file: "peers" });
  });

  it("gives the worker-definition tools bespoke views", () => {
    const create = getToolView("mcp__orchestrator__create_worker");
    expect(create.Detail).not.toBe(GenericDetail);
    expect(create.label({ input: { name: "perf-profiler" } })).toEqual({ verb: "Created worker", file: "perf-profiler" });
    expect(create.runningLabel({ input: { name: "perf-profiler" } })).toEqual({ verb: "Creating worker", file: "perf-profiler" });
    expect(create.label({ input: {} })).toEqual({ verb: "Created worker", file: "" });

    const list = getToolView("mcp__orchestrator__list_available_workers");
    expect(list.Detail).not.toBe(GenericDetail);
    expect(list.runningLabel({})).toEqual({ verb: "Listing", file: "available workers" });
    // count parsed from the result JSON array
    expect(list.label({ result: { text: JSON.stringify([{ name: "a" }, { name: "b" }]) } }))
      .toEqual({ verb: "Listed", file: "available workers (2)" });
    // no result yet (running) → no count
    expect(list.label({})).toEqual({ verb: "Listed", file: "available workers" });
  });
});
