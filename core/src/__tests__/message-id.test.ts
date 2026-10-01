import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReplyBlock, excerpt, prefixOperatorTurn, replyRefOf, replyTargetFromRow, stampAssistantMsgIds, startsWithSlashCommand, stripTurnHead,
} from "../domain/message-id.ts";
import { computeRewindTargets } from "../domain/rewind-targets.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

const row = (id: number, type: string, payload: unknown): WorkerEventRow =>
  ({ id, worker_id: "w1", ts: 1, type, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

const assistantRow = (id: number, text: string, msgId?: string) =>
  row(id, "agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text, ...(msgId ? { msgId } : {}) }] });

const LONG = "word ".repeat(200).trim();

describe("prefixOperatorTurn", () => {
  it("puts the id marker, then the reply block, above the body", () => {
    assert.equal(prefixOperatorTurn("hi", 3, '<reply_to id="2"/>'), '<msg id="3"/>\n<reply_to id="2"/>\nhi');
  });

  it("leaves the body alone when there is nothing to add", () => {
    assert.equal(prefixOperatorTurn("hi", undefined, undefined), "hi");
  });
});

describe("stripTurnHead", () => {
  it("removes exactly the head prefixOperatorTurn added", () => {
    assert.equal(stripTurnHead(prefixOperatorTurn("hi", 3, undefined)), "hi");
    assert.equal(stripTurnHead(prefixOperatorTurn("1 olsun", 4, buildReplyBlock({ rowId: 1, msgId: "3.1", role: "assistant", text: "a\nb </reply_to> c" }, true))), "1 olsun");
    assert.equal(stripTurnHead(prefixOperatorTurn("ok", 5, '<reply_to id="2"/>')), "ok");
  });

  it("leaves text without a head alone, including a mid-text marker", () => {
    assert.equal(stripTurnHead("plain"), "plain");
    assert.equal(stripTurnHead('see <msg id="1"/>\nhere'), 'see <msg id="1"/>\nhere');
  });

  it("rewind targets list the typed prompt, not the delivered head", () => {
    const jsonl = JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "t", message: { role: "user", content: '<msg id="1"/>\nfirst prompt' } });
    const [target] = computeRewindTargets(jsonl);
    assert.equal(target.text, "first prompt");
    assert.equal(target.display, "first prompt");
  });
});

describe("startsWithSlashCommand", () => {
  it("is true only for a leading /token", () => {
    assert.equal(startsWithSlashCommand("/review now"), true);
    assert.equal(startsWithSlashCommand("/ nope"), false);
    assert.equal(startsWithSlashCommand("see /tmp"), false);
  });
});

describe("excerpt", () => {
  it("collapses whitespace and keeps short text whole", () => {
    assert.equal(excerpt("a\n\n  b"), "a b");
  });

  it("cuts long text on a word boundary and marks the cut", () => {
    const e = excerpt(LONG);
    assert.ok(e.endsWith("…"));
    assert.ok(e.length <= 161);
    assert.ok(!e.slice(0, -1).endsWith(" "));
  });
});

describe("buildReplyBlock", () => {
  it("an inbound message the model saw with its id → the bare id", () => {
    assert.equal(buildReplyBlock({ rowId: 1, msgId: "4", role: "user", text: "first" }, true), '<reply_to id="4"/>');
  });

  it("an assistant message → id plus the text, whole when short", () => {
    assert.equal(buildReplyBlock({ rowId: 1, msgId: "3.1", role: "assistant", text: "Pick one" }, true), '<reply_to id="3.1">Pick one</reply_to>');
  });

  it("a long assistant message → an excerpt", () => {
    const block = buildReplyBlock({ rowId: 1, msgId: "3.1", role: "assistant", text: LONG }, true);
    assert.equal(block, `<reply_to id="3.1">${excerpt(LONG)}</reply_to>`);
  });

  it("an inbound message without an id still quotes its text", () => {
    assert.equal(buildReplyBlock({ rowId: 1, role: "user", text: "old" }, true), "<reply_to>old</reply_to>");
  });

  it("a target outside the live context → its full text, even when it had an id", () => {
    assert.equal(buildReplyBlock({ rowId: 1, msgId: "4", role: "user", text: LONG }, false), `<reply_to id="4">${LONG}</reply_to>`);
  });

  it("the full text is capped", () => {
    const huge = "x".repeat(5000);
    const block = buildReplyBlock({ rowId: 1, role: "assistant", text: huge }, false);
    assert.equal(block, `<reply_to>${"x".repeat(4000)}…</reply_to>`);
  });

  it("a quoted </reply_to> can't close the block early", () => {
    const block = buildReplyBlock({ rowId: 1, role: "assistant", text: "a </reply_to> b" }, true);
    assert.equal(block, "<reply_to>a &lt;/reply_to> b</reply_to>");
  });
});

describe("replyTargetFromRow", () => {
  it("reads a user message with its id", () => {
    assert.deepEqual(replyTargetFromRow(row(5, "user_message", { text: "hi", msgId: "2" })), { rowId: 5, role: "user", text: "hi", msgId: "2" });
  });

  it("reads an assistant message: text blocks joined, id of the first stamped block", () => {
    const r = row(6, "agent_event", {
      type: "message", role: "assistant",
      blocks: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "one", msgId: "2.1" }, { type: "text", text: "two", msgId: "2.2" }],
    });
    assert.deepEqual(replyTargetFromRow(r), { rowId: 6, role: "assistant", text: "one\ntwo", msgId: "2.1" });
  });

  it("maps agent-plane and system rows to their roles", () => {
    assert.equal(replyTargetFromRow(row(1, "worker_report", { text: "done", msgId: "7" }))?.role, "agent");
    assert.equal(replyTargetFromRow(row(1, "loop_continuation", { text: "again" }))?.role, "system");
  });

  it("returns null for non-message rows, empty text and bad payloads", () => {
    assert.equal(replyTargetFromRow(row(1, "state", { state: "IDLE" })), null);
    assert.equal(replyTargetFromRow(assistantRow(1, "   ")), null);
    assert.equal(replyTargetFromRow(row(1, "user_message", "not-json")), null);
  });
});

describe("replyRefOf", () => {
  it("snapshots the target with a short excerpt", () => {
    assert.deepEqual(replyRefOf({ rowId: 9, msgId: "3.1", role: "assistant", text: LONG }), { rowId: 9, msgId: "3.1", role: "assistant", excerpt: excerpt(LONG) });
  });
});

describe("stampAssistantMsgIds", () => {
  const counter = () => { let n = 0; return () => `5.${++n}`; };

  it("stamps each non-empty text block in order, nothing else", () => {
    const event: AgentEvent = {
      type: "message", role: "assistant",
      blocks: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "a" },
        { type: "text", text: "  " },
        { type: "tool_call", callId: "c1", name: "Bash", input: {} },
        { type: "text", text: "b" },
      ],
    } as AgentEvent;
    const stamped = stampAssistantMsgIds(event, counter());
    assert.ok(stamped.type === "message");
    assert.deepEqual(stamped.blocks.map((b) => (b.type === "text" ? b.msgId : undefined)), [undefined, "5.1", undefined, undefined, "5.2"]);
  });

  it("passes non-assistant events through untouched", () => {
    const user: AgentEvent = { type: "message", role: "user", blocks: [{ type: "text", text: "x" }] };
    const toolsOnly = { type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: "c", name: "Bash", input: {} }] } as AgentEvent;
    const next = () => { throw new Error("must not allocate"); };
    assert.equal(stampAssistantMsgIds(user, next), user);
    assert.equal(stampAssistantMsgIds(toolsOnly, next), toolsOnly);
  });
});
