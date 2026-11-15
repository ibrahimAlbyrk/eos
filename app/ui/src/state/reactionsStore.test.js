import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/notify.js", () => ({ notify: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { notify } from "../lib/notify.js";
import { _reset as resetQuiet, isQuietTurn, syncQuietTurns } from "./quietTurns.js";
import {
  _reset, applyReactionChange, coverReactions, getReactions, resyncReactions, setReaction, watchReactions,
} from "./reactionsStore.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ok = (body) => async () => ({ ok: true, status: 200, body });
const wire = (rowId, actor, emoji, extra = {}) => ({ rowId, actor, emoji, at: 1000 + rowId, ...extra });
const emojiOf = (workerId, rowId) => {
  const r = getReactions(workerId, rowId);
  return [r.user?.emoji ?? null, r.agent?.emoji ?? null];
};

describe("reactionsStore", () => {
  beforeEach(() => {
    _reset();
    resetQuiet();
    notify.error.mockClear();
  });

  it("reads a chat's reactions from the window's oldest row on, then only each older stretch", async () => {
    const request = vi.fn(async (_id, { fromId }) => (fromId === 100
      ? [wire(120, "user", "👍", { seen: true }), wire(120, "agent", "❤️"), wire(130, "agent", "👀")]
      : [wire(60, "user", "📌", { seen: false })]));
    coverReactions("w1", 100, request);
    await settle();
    expect(request).toHaveBeenLastCalledWith("w1", { fromId: 100, toId: null });
    expect(getReactions("w1", 120)).toMatchObject({ user: { emoji: "👍", seen: true }, agent: { emoji: "❤️" } });
    expect(emojiOf("w1", 130)).toEqual([null, "👀"]);

    // The same window again, or a trimmed one: nothing to ask.
    coverReactions("w1", 100, request);
    coverReactions("w1", 140, request);
    expect(request).toHaveBeenCalledTimes(1);

    coverReactions("w1", 50, request);
    await settle();
    expect(request).toHaveBeenLastCalledWith("w1", { fromId: 50, toId: 99 });
    expect(emojiOf("w1", 60)).toEqual(["📌", null]);
    expect(emojiOf("w1", 120)).toEqual(["👍", "❤️"]);
  });

  it("reads again on a switch back and on a resync, dropping what is gone", async () => {
    let answer = [wire(10, "user", "👍")];
    const request = vi.fn(async () => answer);
    const release = watchReactions("w1", request);
    expect(request).not.toHaveBeenCalled();
    coverReactions("w1", 5, request);
    await settle();
    expect(emojiOf("w1", 10)).toEqual(["👍", null]);

    answer = [wire(12, "agent", "🎉")];
    resyncReactions(request);
    await settle();
    expect(emojiOf("w1", 10)).toEqual([null, null]);
    expect(emojiOf("w1", 12)).toEqual([null, "🎉"]);

    release();
    resyncReactions(request);
    expect(request).toHaveBeenCalledTimes(2);
    watchReactions("w1", request);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("shows a click at once, keeps the core's countdown, and replaces the emoji on the next click", async () => {
    const put = vi.fn(ok({ rowId: 7, actor: "user", emoji: "👍", at: 5, seen: false, wakesInMs: 2000 }));
    const done = setReaction("w1", 7, "👍", { put });
    expect(getReactions("w1", 7).user).toMatchObject({ emoji: "👍", seen: false });
    expect(await done).toBe(true);
    expect(put).toHaveBeenCalledWith("w1", 7, "👍");
    expect(getReactions("w1", 7).user.wakesUntil).toBeGreaterThan(Date.now());

    await setReaction("w1", 7, "👎", { put: ok({ rowId: 7, actor: "user", emoji: "👎", at: 6, seen: false }) });
    const user = getReactions("w1", 7).user;
    expect(user.emoji).toBe("👎");
    expect(user.wakesUntil).toBeUndefined();
  });

  it("takes a reaction back", async () => {
    await setReaction("w1", 7, "👍", { put: ok({}) });
    const remove = vi.fn(ok({ removed: true }));
    expect(await setReaction("w1", 7, null, { remove })).toBe(true);
    expect(remove).toHaveBeenCalledWith("w1", 7);
    expect(getReactions("w1", 7).user).toBeNull();
  });

  it("undoes a click the core refused, and says so", async () => {
    await setReaction("w1", 7, "👍", { put: ok({}) });
    const refused = async () => ({ ok: false, status: 409, body: { error: "this message can't take a reaction" } });
    expect(await setReaction("w1", 7, "🔥", { put: refused })).toBe(false);
    expect(getReactions("w1", 7).user.emoji).toBe("👍");
    expect(notify.error).toHaveBeenCalledWith("Couldn't react: this message can't take a reaction");

    expect(await setReaction("w1", 7, null, { remove: async () => { throw new Error("offline"); } })).toBe(false);
    expect(getReactions("w1", 7).user.emoji).toBe("👍");
    expect(notify.error).toHaveBeenLastCalledWith("Couldn't remove the reaction: offline");
  });

  it("leaves a newer change alone when an older click fails", async () => {
    let fail;
    const slow = () => new Promise((resolve) => { fail = () => resolve({ ok: false, status: 500, body: null }); });
    const first = setReaction("w1", 7, "👍", { put: slow });
    applyReactionChange({ workerId: "w1", rowId: 7, actor: "user", emoji: "🎉", at: 9, seen: false });
    fail();
    await first;
    expect(getReactions("w1", 7).user.emoji).toBe("🎉");
  });

  it("follows the stream: the agent's emoji, a removal, and the agent being told", async () => {
    coverReactions("w1", 1, async () => []);
    await settle();
    applyReactionChange({ workerId: "w1", rowId: 4, actor: "agent", emoji: "👍", at: 1 });
    expect(emojiOf("w1", 4)).toEqual([null, "👍"]);
    applyReactionChange({ workerId: "w1", rowId: 4, actor: "agent", emoji: null, at: 2 });
    expect(emojiOf("w1", 4)).toEqual([null, null]);

    await setReaction("w1", 9, "👌", { put: ok({ wakesInMs: 2000 }) });
    applyReactionChange({ workerId: "w1", rowId: 9, actor: "user", emoji: "👌", at: 3, seen: false });
    expect(getReactions("w1", 9).user.wakesUntil).toBeGreaterThan(Date.now());
    applyReactionChange({ workerId: "w1", rowId: 9, actor: "user", emoji: "👌", at: 3, seen: true });
    expect(getReactions("w1", 9).user).toMatchObject({ emoji: "👌", seen: true, wakesUntil: undefined });

    // A chat this window holds nothing of takes no rows.
    applyReactionChange({ workerId: "w9", rowId: 1, actor: "agent", emoji: "👍", at: 1 });
    expect(emojiOf("w9", 1)).toEqual([null, null]);
  });

  it("does not let a read that began earlier overwrite a frame that came since", async () => {
    let answer;
    const request = () => new Promise((resolve) => { answer = resolve; });
    coverReactions("w1", 1, request);
    applyReactionChange({ workerId: "w1", rowId: 4, actor: "user", emoji: "🎉", at: 9, seen: false });
    answer([wire(4, "user", "👍"), wire(5, "agent", "👀")]);
    await settle();
    expect(emojiOf("w1", 4)).toEqual(["🎉", null]);
    expect(emojiOf("w1", 5)).toEqual([null, "👀"]);
  });

  it("marks the turn a told reaction starts, in any chat, for the unread dot", () => {
    applyReactionChange({ workerId: "w5", rowId: 4, actor: "user", emoji: "👍", at: 1, seen: true });
    syncQuietTurns([{ id: "w5", state: "WORKING" }], async () => []);
    expect(isQuietTurn("w5")).toBe(true);
    applyReactionChange({ workerId: "w6", rowId: 4, actor: "user", emoji: "👍", at: 1, seen: false });
    syncQuietTurns([{ id: "w5", state: "WORKING" }, { id: "w6", state: "WORKING" }], async () => []);
    expect(isQuietTurn("w6")).toBe(false);
  });
});
