import { describe, it, expect, beforeEach } from "vitest";
import { setRecall, getRecall, consumeRecall, subscribe, _reset } from "./recallStore.js";

beforeEach(() => _reset());

// Mirrors the Composer's recall effect: a pane bound to `workerId` applies the
// recalled text into its editor EXACTLY ONCE (consuming at the source), never
// clobbers a draft it is holding, and re-runs on reselect/remount the same way
// the effect re-fires on re-render.
function fakeComposer(workerId) {
  const applied = []; // every text injected into this editor
  const state = { draft: "" };
  const run = () => {
    const r = getRecall();
    if (!r || r.workerId !== workerId) return;
    consumeRecall(r.token);
    if (state.draft.trim()) return; // don't clobber a draft typed after sending
    applied.push(r.content);
    state.draft = r.content; // editor now holds the recalled text
  };
  subscribe(run);
  return {
    applied,
    editor: () => state.draft,
    type: (t) => { state.draft = t; }, // user typing a draft
    send: () => { state.draft = ""; }, // send clears the editor
    clear: () => { state.draft = ""; }, // manual clear
    reselect: run, // switching away/back re-runs the effect
    remount: run, // a fresh mount re-reads the store
  };
}

describe("recallStore one-shot prefill", () => {
  it("injects once and does NOT re-inject on worker reselect", () => {
    const w1 = fakeComposer("w1");
    setRecall("w1", "recalled text");
    expect(w1.applied).toEqual(["recalled text"]);
    expect(getRecall()).toBe(null); // consumed at the source

    w1.send();
    w1.reselect();
    w1.reselect();
    expect(w1.applied).toEqual(["recalled text"]); // still exactly once
  });

  it("does not reappear after send or after a manual clear", () => {
    const w1 = fakeComposer("w1");
    setRecall("w1", "hi");
    expect(w1.editor()).toBe("hi");

    w1.send();
    expect(w1.editor()).toBe("");
    w1.reselect();
    expect(w1.editor()).toBe(""); // no reappearance after send

    w1.clear();
    w1.reselect();
    expect(w1.editor()).toBe(""); // no reappearance after manual clear
    expect(w1.applied).toEqual(["hi"]);
  });

  it("in split view only the pane owning workerId receives the text", () => {
    const w1 = fakeComposer("w1");
    const w2 = fakeComposer("w2");
    setRecall("w2", "for w2 only");
    expect(w2.applied).toEqual(["for w2 only"]);
    expect(w1.applied).toEqual([]);
    expect(w1.editor()).toBe("");
    expect(getRecall()).toBe(null); // the owner consumed it
  });

  it("an SSE reconnect (no new recall event) does not re-prefill", () => {
    const w1 = fakeComposer("w1");
    setRecall("w1", "once");
    expect(w1.applied).toEqual(["once"]);
    w1.send();

    // Reconnect: the ephemeral bus event is not replayed (only the durable
    // message_recalled event is, which keeps the bubble hidden — see
    // messageParser.applyRecalls). No setRecall fires, so a remount/reselect
    // re-reads an empty store.
    w1.remount();
    w1.reselect();
    expect(w1.applied).toEqual(["once"]);
    expect(w1.editor()).toBe("");
  });

  it("does not clobber a draft typed after sending, and still can't come back", () => {
    const w1 = fakeComposer("w1");
    w1.type("my new draft");
    setRecall("w1", "recalled");
    expect(w1.editor()).toBe("my new draft"); // draft preserved
    expect(getRecall()).toBe(null); // but consumed — it won't linger

    w1.clear();
    w1.reselect();
    expect(w1.editor()).toBe(""); // no reappearance
    expect(w1.applied).toEqual([]);
  });

  it("a fresh recall supersedes an un-consumed prior one", () => {
    setRecall("w1", "stale");
    const first = getRecall().token;
    setRecall("w1", "fresh");
    const r = getRecall();
    expect(r.content).toBe("fresh");
    expect(r.token).not.toBe(first);

    // A stale consume (wrong token) must not clear the fresh recall.
    consumeRecall(first);
    expect(getRecall()?.content).toBe("fresh");
  });
});
