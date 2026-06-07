import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRewindTargets,
  rowNeedle,
  countFragments,
  PANEL_FRAGMENTS,
  SUBMENU_FRAGMENTS,
} from "../rewind.ts";
import { normalizeForMatch } from "../delivery.ts";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function userEntry(uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}): string {
  return line({ type: "user", uuid, parentUuid, isSidechain: false, timestamp: `2026-01-01T00:00:0${uuid.length % 10}Z`, message: { role: "user", content }, ...extra });
}

function assistantEntry(uuid: string, parentUuid: string, text: string): string {
  return line({ type: "assistant", uuid, parentUuid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("computeRewindTargets", () => {
  it("lists user prompts oldest-first with descending upCount", () => {
    const jsonl = [
      userEntry("u1", null, "first prompt"),
      assistantEntry("a1", "u1", "reply 1"),
      userEntry("u2", "a1", "second prompt"),
      assistantEntry("a2", "u2", "reply 2"),
    ].join("\n");
    const t = computeRewindTargets(jsonl);
    assert.equal(t.length, 2);
    assert.deepEqual(t.map((x) => x.uuid), ["u1", "u2"]);
    assert.deepEqual(t.map((x) => x.upCount), [2, 1]);
  });

  it("walks only the active branch after a fork (same parentUuid twice)", () => {
    const jsonl = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "r1"),
      userEntry("u2", "a1", "abandoned branch"),
      assistantEntry("a2", "u2", "dead reply"),
      // rewind happened: resubmit branches from a1 again
      userEntry("u3", "a1", "live branch"),
      assistantEntry("a3", "u3", "live reply"),
    ].join("\n");
    const t = computeRewindTargets(jsonl);
    assert.deepEqual(t.map((x) => x.uuid), ["u1", "u3"]);
  });

  it("skips tool_result-only, meta, sidechain and interrupt entries", () => {
    const jsonl = [
      userEntry("u1", null, "real prompt"),
      assistantEntry("a1", "u1", "r"),
      userEntry("u2", "a1", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
      assistantEntry("a2", "u2", "r2"),
      userEntry("u3", "a2", [{ type: "text", text: "[Image: /x.png]" }], { isMeta: true }),
      userEntry("u4", "a2", [{ type: "text", text: "[Request interrupted by user]" }]),
      userEntry("u5", "u4", "after interrupt"),
    ].join("\n");
    const t = computeRewindTargets(jsonl);
    assert.deepEqual(t.map((x) => x.uuid), ["u1", "u5"]);
    assert.deepEqual(t.map((x) => x.upCount), [2, 1]);
  });

  it("collapses slash commands to a display form", () => {
    const cmd = "<command-name>/create-pr</command-name>\n<command-message>create-pr</command-message>\n<command-args>--draft</command-args>";
    const jsonl = [userEntry("u1", null, cmd)].join("\n");
    const t = computeRewindTargets(jsonl);
    assert.equal(t[0].display, "/create-pr --draft");
    assert.equal(t[0].text, cmd);
  });

  it("extracts text blocks and tolerates torn lines", () => {
    const jsonl = [
      userEntry("u1", null, [{ type: "text", text: "hello" }, { type: "image", source: {} }]),
      "{ torn json",
    ].join("\n");
    const t = computeRewindTargets(jsonl);
    assert.equal(t.length, 1);
    assert.equal(t[0].text, "hello");
  });

  it("returns empty for empty or assistant-less garbage transcripts", () => {
    assert.deepEqual(computeRewindTargets(""), []);
    assert.deepEqual(computeRewindTargets(line({ type: "summary" })), []);
  });
});

describe("screen fragment matching", () => {
  it("panel detection survives partial repaints (real capture)", () => {
    // From the live claude 2.1.168 test: letters dropped by incremental repaint.
    const capture = "RewindRestorethecodeand/orconversationtothepointbefore…↑ 1 more aboveReplywithexactlytheword:BRAVONo code changes  ❯ (current)Enter to continue · Esc to cancel";
    const n = normalizeForMatch(capture);
    assert.ok(countFragments(n, PANEL_FRAGMENTS) >= 2);
  });

  it("submenu detection survives dropped characters (real capture)", () => {
    const capture = "Confimyouwantto restore to the point bfore you sent thismessage:│Reply with exactly the word: BRAVO│(7s ago)The conversation will be forked.The code will b unchanged.❯1. Restore conversation 2.Summarize fromhere3. Summarizeuptohere  4. Never mind";
    const n = normalizeForMatch(capture);
    assert.ok(countFragments(n, SUBMENU_FRAGMENTS) >= 2);
  });

  it("idle composer repaint does not look like the panel", () => {
    const capture = "❯ Reply with exactly the word: ALPHA  Thought for 2s ⏺ALPHA  Haiku 4.5 ╱ sandbox │ ╭ ◆◇◇◇ 13%";
    const n = normalizeForMatch(capture);
    assert.ok(countFragments(n, PANEL_FRAGMENTS) < 2);
  });
});

describe("rowNeedle", () => {
  it("uses only the first line of multi-line prompts", () => {
    assert.equal(rowNeedle("Print exactly these two words:\nDELTA ECHO"), normalizeForMatch("Print exactly these two words:").slice(0, 16));
  });

  it("returns null for too-short needles", () => {
    assert.equal(rowNeedle("ok"), null);
  });
});
