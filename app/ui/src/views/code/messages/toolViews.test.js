import { describe, it, expect } from "vitest";
import { getToolView } from "./toolViews.jsx";
import { GenericToolCard } from "./ToolDetail.jsx";
import { WorkerToolBody } from "./WorkerToolCard.jsx";

describe("getToolView", () => {
  it("falls back to the generic view for unknown tools (humanized name)", () => {
    const v = getToolView("mcp__context7__query-docs");
    expect(v.Detail).toBe(GenericToolCard);
    expect(v.label({ name: "mcp__context7__query-docs" })).toEqual({ verb: "Used", file: "context7 · query-docs" });
    expect(v.runningLabel({ name: "mcp__context7__query-docs" })).toEqual({ verb: "Running", file: "context7 · query-docs" });
    expect(v.filePath({ input: {} })).toBe(null);
    expect(v.stats({ input: {} })).toBe(null);
    expect(v.expandable({}, {})).toBe(true);
  });

  it("surfaces an args summary only on the fallback, not on bespoke views", () => {
    expect(getToolView("mcp__x__y").summary({ input: { query: "hello" } })).toBe("hello");
    expect(getToolView("Read").summary({ input: { file_path: "/a/b.ts" } })).toBe(null);
  });

  it("returns the same default view for any unregistered name", () => {
    expect(getToolView("foo").Detail).toBe(getToolView("bar").Detail);
    expect(getToolView(undefined).Detail).toBe(GenericToolCard);
  });

  it("uses a bespoke Detail for known tools", () => {
    expect(getToolView("Read").Detail).not.toBe(GenericToolCard);
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

  it("gives MultiEdit a bespoke view matching Edit", () => {
    const v = getToolView("MultiEdit");
    expect(v.Detail).not.toBe(GenericToolCard);
    const tool = { input: { file_path: "/a/b.ts", edits: [{ old_string: "x", new_string: "y" }] } };
    expect(v.label(tool)).toEqual({ verb: "Edit", file: "b.ts" });
    expect(v.runningLabel(tool)).toEqual({ verb: "Editing", file: "b.ts" });
    expect(v.filePath(tool)).toBe("/a/b.ts");
  });

  it("computes MultiEdit diff stats across all edits", () => {
    const stats = getToolView("MultiEdit").stats({
      input: {
        file_path: "/a/b.ts",
        edits: [
          { old_string: "a\nb", new_string: "a\nb\nc" },
          { old_string: "x\ny", new_string: "x" },
        ],
      },
    });
    expect(stats).toEqual({ add: 1, del: 1 });
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
    expect(ask.Detail).not.toBe(GenericToolCard);
    expect(ask.label({ input: { peerId: "w-7" } })).toEqual({ verb: "Asked", file: "w-7" });
    expect(ask.runningLabel({ input: { peerId: "w-7" } })).toEqual({ verb: "Asking", file: "w-7" });
    // agentRef resolves the peer by id (AgentLink fills the name from workers)
    expect(ask.agentRef({ input: { peerId: "w-7" } })).toEqual({ id: "w-7", name: null });
    expect(ask.agentRef({ input: {} })).toBe(null);

    const respond = getToolView("mcp__worker__respond_to_peer");
    expect(respond.Detail).not.toBe(GenericToolCard);
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
    expect(list.Detail).not.toBe(GenericToolCard);
    expect(list.label({})).toEqual({ verb: "Listed", file: "peers" });
  });

  it("gives the worker-definition tools bespoke views", () => {
    const create = getToolView("mcp__orchestrator__create_worker");
    expect(create.Detail).not.toBe(GenericToolCard);
    expect(create.label({ input: { name: "perf-profiler" } })).toEqual({ verb: "Created worker", file: "perf-profiler" });
    expect(create.runningLabel({ input: { name: "perf-profiler" } })).toEqual({ verb: "Creating worker", file: "perf-profiler" });
    expect(create.label({ input: {} })).toEqual({ verb: "Created worker", file: "" });

    const list = getToolView("mcp__orchestrator__list_available_workers");
    expect(list.Detail).not.toBe(GenericToolCard);
    expect(list.runningLabel({})).toEqual({ verb: "Listing", file: "available workers" });
    // count parsed from the result JSON array
    expect(list.label({ result: { text: JSON.stringify([{ name: "a" }, { name: "b" }]) } }))
      .toEqual({ verb: "Listed", file: "available workers (2)" });
    // no result yet (running) → no count
    expect(list.label({})).toEqual({ verb: "Listed", file: "available workers" });
  });

  it("resolves the worker-management tools through the one dispatcher", () => {
    // spawn/kill/message/get → AgentLink target + WorkerToolBody
    const kill = getToolView("mcp__orchestrator__kill_worker");
    expect(kill.Detail).toBe(WorkerToolBody);
    expect(kill.label({}).verb).toBe("Killed");
    expect(kill.runningLabel({}).verb).toBe("Killing");
    expect(kill.agentRef({ name: "mcp__orchestrator__kill_worker", input: { id: "w1", name: "alice" } }, { workers: [] }))
      .toEqual({ id: "w1", name: "alice" });
    // expand gate: detail text present → expandable; running w/ no result → not
    const ctx = { workers: [] };
    expect(kill.expandable({ name: "mcp__orchestrator__kill_worker", result: { text: JSON.stringify({ state: "killed", branch: "eos-x" }) } }, ctx)).toBe(true);
    expect(kill.expandable({ name: "mcp__orchestrator__kill_worker" }, ctx)).toBe(false);

    // list tools → count/label target, no agentRef
    const listActive = getToolView("mcp__orchestrator__list_active_workers");
    expect(listActive.Detail).toBe(WorkerToolBody);
    expect(listActive.agentRef({}, ctx)).toBe(null);
    expect(listActive.label({ name: "mcp__orchestrator__list_active_workers", result: { text: JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]) } }))
      .toEqual({ verb: "Listed", file: "workers (3)" });
    expect(listActive.label({ name: "mcp__orchestrator__list_active_workers" })).toEqual({ verb: "Listed", file: "workers" });

    const pending = getToolView("mcp__orchestrator__list_pending_permissions");
    expect(pending.label({ name: "mcp__orchestrator__list_pending_permissions" })).toEqual({ verb: "Checked", file: "pending permissions" });
  });

  it("gives current_datetime a bespoke single-line view on both lanes", () => {
    for (const name of ["mcp__orchestrator__current_datetime", "mcp__worker__current_datetime"]) {
      const v = getToolView(name);
      expect(v.Detail).not.toBe(GenericToolCard);
      expect(v.label({})).toEqual({ verb: "Checked", file: "date & time" });
      expect(v.runningLabel({})).toEqual({ verb: "Checking", file: "date & time" });
    }
  });

  it("renders a loop badge on spawn_worker only when armed at spawn", () => {
    const spawn = getToolView("mcp__orchestrator__spawn_worker");
    expect(spawn.Detail).toBe(WorkerToolBody);
    expect(spawn.label({}).verb).toBe("Spawned");

    const armed = spawn.headerBadge({ input: { loop: { goal: { summary: "tests green" }, strategy: "command", limit: 3 } } });
    expect(armed).not.toBe(null);
    expect(armed.props.className).toBe("ti-loop-badge");
    expect(armed.props.title).toBe("Loop: tests green · command · limit 3");

    // no loop arg → no badge; other worker tools never carry one
    expect(spawn.headerBadge({ input: {} })).toBe(null);
    expect(getToolView("mcp__orchestrator__kill_worker").headerBadge({ input: { loop: {} } })).toBe(null);
  });
});
