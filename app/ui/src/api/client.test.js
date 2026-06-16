import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./client.js";
import { ROUTES } from "./routes.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.answerQuestion wire contract", () => {
  it("POSTs { toolUseId, answers } to the question-answer route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.answerQuestion("w1", "tu-1", { Q: "opt" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workerQuestionAnswer("w1"));
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ toolUseId: "tu-1", answers: { Q: "opt" } });
  });

  it("adds dismissed: true when the operator skips", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.answerQuestion("w1", "tu-1", {}, true);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ toolUseId: "tu-1", answers: {}, dismissed: true });
  });
});
