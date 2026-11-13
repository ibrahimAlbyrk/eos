import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: { getWorkerSubagents: vi.fn(), getWorkerArtifacts: vi.fn() },
}));

import { api } from "../api/client.js";
import { MAX_CHATS, REFRESH_MS, _resetLists, getLists, requestLists } from "./conversationListsStore.js";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

let answer = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetLists();
  answer = 0;
  api.getWorkerSubagents.mockImplementation(async () => [{ answer: ++answer }]);
  api.getWorkerArtifacts.mockImplementation(async () => []);
});
afterEach(() => vi.useRealTimers());

describe("conversationListsStore", () => {
  it("loads a chat's summaries at once, then not again while they cover its window", async () => {
    requestLists("w1", 10);
    await flush();
    expect(api.getWorkerSubagents).toHaveBeenCalledTimes(1);
    expect(getLists("w1")).toEqual({ subagents: [{ answer: 1 }], artifacts: [] });
    requestLists("w1", 10);
    requestLists("w1", 9);
    vi.advanceTimersByTime(REFRESH_MS * 3);
    await flush();
    expect(api.getWorkerSubagents).toHaveBeenCalledTimes(1);
  });

  it("asks once more for a burst of new rows, after a pause", async () => {
    requestLists("w1", 10);
    await flush();
    for (let end = 11; end <= 20; end++) requestLists("w1", end);
    expect(api.getWorkerSubagents).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_MS);
    await flush();
    expect(api.getWorkerSubagents).toHaveBeenCalledTimes(2);
    expect(getLists("w1").subagents).toEqual([{ answer: 2 }]);
    requestLists("w1", 20);
    vi.advanceTimersByTime(REFRESH_MS);
    await flush();
    expect(api.getWorkerSubagents).toHaveBeenCalledTimes(2);
  });

  it("asks again for rows that landed while it was asking", async () => {
    let release;
    api.getWorkerSubagents.mockImplementationOnce(() => new Promise((r) => { release = () => r([{ answer: "slow" }]); }));
    requestLists("w1", 10);
    requestLists("w1", 11);
    release();
    await flush();
    expect(getLists("w1").subagents).toEqual([{ answer: "slow" }]);
    vi.advanceTimersByTime(REFRESH_MS);
    await flush();
    expect(api.getWorkerSubagents).toHaveBeenCalledTimes(2);
  });

  it("keeps what it had when an ask fails", async () => {
    requestLists("w1", 10);
    await flush();
    api.getWorkerSubagents.mockRejectedValueOnce(new Error("down"));
    requestLists("w1", 11);
    vi.advanceTimersByTime(REFRESH_MS);
    await flush();
    expect(getLists("w1").subagents).toEqual([{ answer: 1 }]);
  });

  it("forgets the chats asked least recently past its bound", async () => {
    for (let n = 0; n <= MAX_CHATS; n++) requestLists(`w${n}`, 1);
    await flush();
    expect(getLists("w0")).toBeNull();
    expect(getLists("w1")).not.toBeNull();
    expect(getLists(`w${MAX_CHATS}`)).not.toBeNull();
  });
});
