import { describe, it, expect, beforeEach } from "vitest";
import {
  blocksAcrossConversation, cachedConversationRows, rememberConversationRows, coversWindow, _resetConversationRows,
} from "./useConversationBlocks.js";
import { collectSubagents } from "../lib/subagentRuns.js";
import { collectArtifacts } from "../lib/artifactLink.js";

let id = 0;
const ev = (type, payload) => ({ id: ++id, ts: id * 10, type, payload });
const agent = (type, payload) => ev("agent_event", { type, ...payload });
const launch = (callId, description) =>
  agent("message", { role: "assistant", blocks: [{ type: "tool_call", callId, name: "Agent", spawnsSubagent: true, input: { description } }] });
const finish = (callId, content = "done") =>
  agent("message", { role: "tool", blocks: [{ type: "tool_result", callId, content }] });
const publish = (callId, title) =>
  agent("message", { role: "assistant", blocks: [{ type: "tool_call", callId, name: "Artifact", input: { title, file_path: "x.html" } }] });
const subagentsAcrossConversation = (...args) => collectSubagents(blocksAcrossConversation(...args));

describe("blocksAcrossConversation", () => {
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

  it("lists artifacts published before the window", () => {
    id = 0;
    const older = publish("AR", "Old page");
    const olderDone = finish("AR", "Published https://claude.ai/code/artifact/abc-123");
    const windowRow = launch("AG", "later");
    const artifacts = collectArtifacts(blocksAcrossConversation([older, olderDone], [windowRow], 0));
    expect(artifacts.map((a) => [a.url, a.title])).toEqual([["https://claude.ai/code/artifact/abc-123", "Old page"]]);
  });
});

describe("conversation rows cache", () => {
  beforeEach(() => _resetConversationRows());
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

  it("keeps each chat's rows, so a switch-back finds them without a fetch", () => {
    const a = rows(3);
    rememberConversationRows("A", a, 3);
    rememberConversationRows("B", rows(2), 2);
    expect(cachedConversationRows("A")).toEqual({ rows: a, coveredTo: 3 });
    expect(coversWindow(cachedConversationRows("A"), 2)).toBe(true);
  });

  it("is fetched again once the window starts after the snapshot", () => {
    rememberConversationRows("A", rows(3), 10);
    expect(coversWindow(cachedConversationRows("A"), 10)).toBe(true);
    expect(coversWindow(cachedConversationRows("A"), 11)).toBe(false);
    expect(coversWindow(cachedConversationRows("missing"), 1)).toBe(false);
  });

  it("drops the oldest chat past five", () => {
    for (const id of ["A", "B", "C", "D", "E", "F"]) rememberConversationRows(id, rows(1), 1);
    expect(cachedConversationRows("A")).toBeNull();
    expect(cachedConversationRows("B")).not.toBeNull();
    expect(cachedConversationRows("F")).not.toBeNull();
  });

  it("a refetch makes a chat the newest", () => {
    for (const id of ["A", "B", "C", "D", "E"]) rememberConversationRows(id, rows(1), 1);
    rememberConversationRows("A", rows(1), 2);
    rememberConversationRows("F", rows(1), 1);
    expect(cachedConversationRows("A")).not.toBeNull();
    expect(cachedConversationRows("B")).toBeNull();
  });

  it("drops the oldest chats past the row budget, never the one just fetched", () => {
    rememberConversationRows("A", rows(25_000), 1);
    rememberConversationRows("B", rows(20_000), 1);
    expect(cachedConversationRows("A")).toBeNull();
    expect(cachedConversationRows("B")).not.toBeNull();
    rememberConversationRows("C", rows(50_000), 1);
    expect(cachedConversationRows("B")).toBeNull();
    expect(cachedConversationRows("C")).not.toBeNull();
  });
});
