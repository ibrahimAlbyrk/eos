import { describe, it, expect, vi } from "vitest";
import { createWarmer } from "./warmOnType.js";

describe("createWarmer", () => {
  it("warms a resting chat once the user types", () => {
    const warm = vi.fn();
    const onDraft = createWarmer(warm);
    onDraft("w1", "SUSPENDED", "");
    expect(warm).not.toHaveBeenCalled();
    onDraft("w1", "SUSPENDED", "h");
    expect(warm).toHaveBeenCalledWith("w1");
  });

  it("asks only once per rest period", () => {
    const warm = vi.fn();
    const onDraft = createWarmer(warm);
    onDraft("w1", "SUSPENDED", "h");
    onDraft("w1", "SUSPENDED", "he");
    expect(warm).toHaveBeenCalledTimes(1);
    // The chat came back to life, then rested again: the next edit warms it.
    onDraft("w1", "IDLE", "hel");
    onDraft("w1", "SUSPENDED", "hel");
    expect(warm).toHaveBeenCalledTimes(1);
    onDraft("w1", "SUSPENDED", "hell");
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it("a draft left in a chat that went to rest doesn't wake it", () => {
    const warm = vi.fn();
    const onDraft = createWarmer(warm);
    onDraft("w1", "IDLE", "draft");
    onDraft("w1", "SUSPENDED", "draft");
    expect(warm).not.toHaveBeenCalled();
  });

  it("leaves live chats, cleared drafts and missing workers alone", () => {
    const warm = vi.fn();
    const onDraft = createWarmer(warm);
    onDraft("w1", "IDLE", "a");
    onDraft("w1", "WORKING", "ab");
    onDraft("w1", "SUSPENDED", "  ");
    onDraft(undefined, undefined, "abc");
    expect(warm).not.toHaveBeenCalled();
  });

  it("warms a finished chat too", () => {
    const warm = vi.fn();
    createWarmer(warm)("w2", "DONE", "x");
    expect(warm).toHaveBeenCalledWith("w2");
  });

  it("swallows a failed request", async () => {
    const warm = vi.fn(() => Promise.reject(new Error("offline")));
    createWarmer(warm)("w1", "SUSPENDED", "x");
    await Promise.resolve();
    expect(warm).toHaveBeenCalledTimes(1);
  });
});
