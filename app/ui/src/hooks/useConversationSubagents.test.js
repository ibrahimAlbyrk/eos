import { describe, it, expect } from "vitest";
import { subagentsAcrossConversation } from "./useConversationSubagents.js";

let id = 0;
const ev = (type, payload) => ({ id: ++id, ts: id * 10, type, payload });
const agent = (type, payload) => ev("agent_event", { type, ...payload });
const launch = (callId, description) =>
  agent("message", { role: "assistant", blocks: [{ type: "tool_call", callId, name: "Agent", spawnsSubagent: true, input: { description } }] });
const finish = (callId, content = "done") =>
  agent("message", { role: "tool", blocks: [{ type: "tool_result", callId, content }] });

describe("subagentsAcrossConversation", () => {
  it("lists subagents from the fetched older rows alongside the window's", () => {
    id = 0;
    const olderLaunch = launch("OLD", "old one");
    const olderFinish = finish("OLD");
    const windowLaunch = launch("NEW", "new one");
    const fetched = [olderLaunch, olderFinish, windowLaunch];
    const runs = subagentsAcrossConversation(fetched, [windowLaunch], 0);
    expect(runs.map((r) => [r.toolUseId, r.status])).toEqual([["OLD", "completed"], ["NEW", "running"]]);
  });

  it("closes a subagent launched before the window and finished inside it", () => {
    id = 0;
    const olderLaunch = launch("AG", "straddler");
    const windowFinish = finish("AG", "report");
    const runs = subagentsAcrossConversation([olderLaunch], [windowFinish], 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ toolUseId: "AG", status: "completed", result: "report" });
  });

  it("prefers the window's rows over the same ids in the snapshot", () => {
    id = 0;
    const l = launch("AG", "x");
    const windowFinish = finish("AG");
    const runs = subagentsAcrossConversation([l, windowFinish], [l, windowFinish], 0);
    expect(runs).toHaveLength(1);
  });

  it("drops subagents before the last /clear", () => {
    id = 0;
    const gone = launch("GONE", "wiped");
    const cleared = ev("conversation_cleared", {});
    const kept = launch("KEPT", "after");
    const runs = subagentsAcrossConversation([gone, cleared], [kept], 0);
    expect(runs.map((r) => r.toolUseId)).toEqual(["KEPT"]);
  });
});
