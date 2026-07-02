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

describe("archive wire contract (frozen backend contract)", () => {
  const okFetch = (body = { ok: true }) =>
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it("archiveWorker POSTs to /workers/:id/archive", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.archiveWorker("w1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workerArchive("w1"));
    expect(opts.method).toBe("POST");
  });

  it("restoreWorker POSTs to /workers/:id/restore", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.restoreWorker("w1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workerRestore("w1"));
    expect(opts.method).toBe("POST");
  });

  it("purgeWorker DELETEs /workers/:id/purge", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.purgeWorker("w1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workerPurge("w1"));
    expect(opts.method).toBe("DELETE");
  });

  it("killWorker DELETEs /workers/:id (permanent delete of a live agent)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.killWorker("w1");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url.endsWith(ROUTES.worker("w1"))).toBe(true);
    expect(opts.method).toBe("DELETE");
  });

  it("listArchivedWorkers GETs /workers/archived and returns the rows", async () => {
    const rows = [{ id: "w1", archived_at: 123 }];
    const fetchMock = okFetch(rows);
    vi.stubGlobal("fetch", fetchMock);

    const body = await api.listArchivedWorkers();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workersArchived);
    expect(opts?.method).toBeUndefined();
    expect(body).toEqual(rows);
  });

  it("listArchivedWorkers throws on a non-ok response (listWorkers convention)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => null });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listArchivedWorkers()).rejects.toThrow("listArchivedWorkers → 500");
  });
});

describe("api.renameIntent wire contract", () => {
  it("PUTs { active: true } to the rename-intent route (editor opened → pause)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await api.renameIntent("w1", true);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workerRenameIntent("w1"));
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ active: true });
  });

  it("PUTs { active: false } (editor closed without commit → resume)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await api.renameIntent("w2", false);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ active: false });
  });
});
