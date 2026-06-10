import { describe, it, expect } from "vitest";
import { NEW_AGENT_KEY, draftKey, isEmptyDraft, getDraft, saveDraft, deleteDraft } from "./composerDrafts.js";

let nextId = 0;
const freshKey = () => `w${nextId++}`;
const draft = (over = {}) => ({
  text: "hello", cursorPos: 5, insertedPaths: [], attachments: [],
  gitMode: false, termMode: false, ...over,
});

describe("draftKey", () => {
  it("maps null selection to the new-agent sentinel", () => {
    expect(draftKey(null)).toBe(NEW_AGENT_KEY);
    expect(draftKey(undefined)).toBe(NEW_AGENT_KEY);
  });

  it("maps a real id to itself", () => {
    expect(draftKey("w1")).toBe("w1");
  });
});

describe("isEmptyDraft", () => {
  it("treats null and blank drafts as empty", () => {
    expect(isEmptyDraft(null)).toBe(true);
    expect(isEmptyDraft(draft({ text: "" }))).toBe(true);
  });

  it("keeps drafts with text, attachments, or an active mode", () => {
    expect(isEmptyDraft(draft())).toBe(false);
    expect(isEmptyDraft(draft({ text: "", attachments: [{ label: "{image #1}" }] }))).toBe(false);
    expect(isEmptyDraft(draft({ text: "", termMode: true }))).toBe(false);
    expect(isEmptyDraft(draft({ text: "", gitMode: true }))).toBe(false);
  });
});

describe("composerDrafts store", () => {
  it("returns null for an unknown key", () => {
    expect(getDraft(freshKey())).toBeNull();
  });

  it("round-trips a saved draft", () => {
    const key = freshKey();
    const d = draft();
    saveDraft(key, d);
    expect(getDraft(key)).toBe(d);
  });

  it("keeps drafts isolated per key", () => {
    const a = freshKey();
    const b = freshKey();
    saveDraft(a, draft({ text: "for A" }));
    expect(getDraft(b)).toBeNull();
    expect(getDraft(a).text).toBe("for A");
  });

  it("drops the stored entry when an empty draft is saved over it", () => {
    const key = freshKey();
    saveDraft(key, draft());
    saveDraft(key, draft({ text: "" }));
    expect(getDraft(key)).toBeNull();
  });

  it("deleteDraft removes the entry", () => {
    const key = freshKey();
    saveDraft(key, draft());
    deleteDraft(key);
    expect(getDraft(key)).toBeNull();
  });
});
