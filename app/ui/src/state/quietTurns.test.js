import { describe, it, expect, beforeEach, vi } from "vitest";
import { needsAttention, sigOf } from "../lib/agentAttention.js";
import { _reset, isQuietTurn, noteReactionTold, subscribeQuietTurns, syncQuietTurns } from "./quietTurns.js";

const row = (payload) => ({ id: 1, type: "agent_event", ts: 1, payload: JSON.stringify(payload) });
const silentTail = [row({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: "n", name: "mcp__worker__no_reply", input: {} }] })];
const spokenTail = [row({ type: "message", role: "assistant", blocks: [{ type: "text", text: "Deleted." }] })];
const worker = (state, tokens = 0) => ({ id: "w1", state, tokens_in: tokens, tokens_out: 0, tool_calls: 0, cost_usd: 0 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("quiet turns", () => {
  beforeEach(() => _reset());

  it("hold the unread dot back for a turn the agent answered with silence", async () => {
    const viewed = sigOf(worker("IDLE"));
    const changed = vi.fn();
    subscribeQuietTurns(changed);
    const read = vi.fn(async () => silentTail);

    noteReactionTold("w1");
    syncQuietTurns([worker("IDLE")], read);
    expect(isQuietTurn("w1")).toBe(false);
    syncQuietTurns([worker("WORKING", 10)], read);
    expect(isQuietTurn("w1")).toBe(true);
    const idle = worker("IDLE", 20);
    syncQuietTurns([idle], read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(needsAttention(viewed, idle, isQuietTurn("w1"))).toBe(false);
    await settle();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(needsAttention(viewed, idle, isQuietTurn("w1"))).toBe(false);

    // Its next turn is any turn again.
    syncQuietTurns([worker("WORKING", 30)], read);
    const later = worker("IDLE", 40);
    syncQuietTurns([later], read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(needsAttention(viewed, later, isQuietTurn("w1"))).toBe(true);
  });

  it("let the dot through once the turn turns out to have said something", async () => {
    const viewed = sigOf(worker("IDLE"));
    noteReactionTold("w1");
    syncQuietTurns([worker("WORKING", 10)], async () => spokenTail);
    const idle = worker("IDLE", 20);
    syncQuietTurns([idle], async () => spokenTail);
    await settle();
    expect(needsAttention(viewed, idle, isQuietTurn("w1"))).toBe(true);
  });

  it("show the dot when the end of the turn could not be read", async () => {
    noteReactionTold("w1");
    syncQuietTurns([worker("WORKING")], async () => silentTail);
    syncQuietTurns([worker("IDLE")], async () => { throw new Error("offline"); });
    await settle();
    expect(isQuietTurn("w1")).toBe(false);
  });

  it("keep the dot held when another reaction follows a silent turn", async () => {
    noteReactionTold("w1");
    syncQuietTurns([worker("WORKING")], async () => silentTail);
    syncQuietTurns([worker("IDLE")], async () => silentTail);
    await settle();
    noteReactionTold("w1");
    expect(isQuietTurn("w1")).toBe(true);
    syncQuietTurns([worker("IDLE")], async () => spokenTail);
    expect(isQuietTurn("w1")).toBe(true);
  });

  it("forget a worker that is gone", () => {
    noteReactionTold("w1");
    syncQuietTurns([worker("WORKING")], async () => silentTail);
    syncQuietTurns([{ id: "w2", state: "IDLE" }], async () => silentTail);
    expect(isQuietTurn("w1")).toBe(false);
  });
});
