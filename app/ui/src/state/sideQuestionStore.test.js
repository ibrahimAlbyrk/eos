import { describe, it, expect, vi, beforeEach } from "vitest";

const askSideQuestion = vi.fn();
vi.mock("../api/client.js", () => ({
  api: { askSideQuestion: (...a) => askSideQuestion(...a) },
}));

const store = await import("./sideQuestionStore.js");

// A request the test settles by hand; aborting rejects it like fetch does.
function deferred() {
  let resolve;
  let signal;
  const promise = new Promise((res, rej) => {
    resolve = res;
    askSideQuestion.mockImplementationOnce((_id, _q, opts) => {
      signal = opts.signal;
      signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      return promise;
    });
  });
  return { resolve: (v) => resolve(v), signal: () => signal };
}

beforeEach(() => {
  store._reset();
  askSideQuestion.mockReset();
});

describe("sideQuestionStore", () => {
  it("asks the trimmed question and keeps the answer", async () => {
    const req = deferred();
    store.askSideQuestion("w-1", "  why?  ");
    expect(askSideQuestion).toHaveBeenCalledWith("w-1", "why?", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(store.getSideQuestion("w-1")).toMatchObject({ question: "why?", status: "asking" });
    req.resolve({ ok: true, status: 200, body: { answer: "because" } });
    await vi.waitFor(() => expect(store.getSideQuestion("w-1")).toMatchObject({ status: "done", answer: "because" }));
  });

  it("shows the daemon's reason when it can't answer", async () => {
    const req = deferred();
    store.askSideQuestion("w-1", "q");
    req.resolve({ ok: false, status: 409, body: { error: "the agent isn't running" } });
    await vi.waitFor(() => expect(store.getSideQuestion("w-1")).toMatchObject({ status: "error", error: "the agent isn't running" }));
  });

  it("a new question cancels and replaces the one still being answered", async () => {
    const first = deferred();
    store.askSideQuestion("w-1", "first");
    const second = deferred();
    store.askSideQuestion("w-1", "second");
    expect(first.signal().aborted).toBe(true);
    second.resolve({ ok: true, status: 200, body: { answer: "two" } });
    await vi.waitFor(() => expect(store.getSideQuestion("w-1")).toMatchObject({ question: "second", status: "done", answer: "two" }));
  });

  it("ignores an empty question", () => {
    store.askSideQuestion("w-1", "   ");
    expect(askSideQuestion).not.toHaveBeenCalled();
    expect(store.getSideQuestion("w-1")).toBeNull();
  });

  it("pruning an agent that left cancels its question and forgets it", async () => {
    const gone = deferred();
    store.askSideQuestion("w-gone", "q");
    const kept = deferred();
    store.askSideQuestion("w-1", "q");
    store.pruneExcept(new Set(["w-1"]));
    expect(gone.signal().aborted).toBe(true);
    expect(store.getSideQuestion("w-gone")).toBeNull();
    expect(kept.signal().aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getSideQuestion("w-gone")).toBeNull();
  });
});
