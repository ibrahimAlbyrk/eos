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

describe("gitdiff read glue", () => {
  const okFetch = (body) =>
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it("getGitStashes GETs /fs/stashes with the cwd and returns the body", async () => {
    const body = { stashes: [{ index: 0, sha: "abc1234", subject: "WIP", ts: 1, branch: "dev" }] };
    const fetchMock = okFetch(body);
    vi.stubGlobal("fetch", fetchMock);

    const out = await api.getGitStashes("/repo/x");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.fsStashes);
    expect(url).toContain(`cwd=${encodeURIComponent("/repo/x")}`);
    expect(opts?.method).toBeUndefined();
    expect(out).toEqual(body);
  });

  it("getGitStashes degrades to an empty list on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => null });
    vi.stubGlobal("fetch", fetchMock);

    expect(await api.getGitStashes("/repo/x")).toEqual({ stashes: [] });
  });

  it("gitBlobUrl builds an /fs/blob URL with cwd, ref, path", () => {
    const url = api.gitBlobUrl("/repo/x", "deadbee", "assets/logo.png");
    expect(url).toContain(ROUTES.fsBlob);
    expect(url).toContain(`cwd=${encodeURIComponent("/repo/x")}`);
    expect(url).toContain("ref=deadbee");
    expect(url).toContain(`path=${encodeURIComponent("assets/logo.png")}`);
  });

  it("stashApply POSTs { cwd, index } to /fs/stash/apply", async () => {
    const fetchMock = okFetch({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await api.stashApply("/repo/x", 2);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.fsStashApply);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ cwd: "/repo/x", index: 2 });
  });

  it("stashDrop POSTs { cwd, index } to /fs/stash/drop", async () => {
    const fetchMock = okFetch({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await api.stashDrop("/repo/x", 0);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.fsStashDrop);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ cwd: "/repo/x", index: 0 });
  });

  it("openPathIn POSTs { path, target } to /fs/open-in", async () => {
    const fetchMock = okFetch({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await api.openPathIn("/repo/x/a.ts", "vscode");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.fsOpenIn);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ path: "/repo/x/a.ts", target: "vscode" });
  });
});

describe("deduped GETs survive concurrent callers", () => {
  // Real Response bodies are single-read — json() rejects on the second read.
  // The re-readable mocks above hide that, so model it explicitly here.
  const singleReadResponse = (body) => {
    let used = false;
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (used) throw new TypeError("Body has already been consumed");
        used = true;
        return body;
      },
    };
  };

  it("concurrent same-URL GETs share one request and BOTH get the parsed body", async () => {
    const rows = [{ id: "w1", archived_at: 123 }];
    const fetchMock = vi.fn().mockImplementation(async () => singleReadResponse(rows));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([api.listArchivedWorkers(), api.listArchivedWorkers()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(rows);
    expect(b).toEqual(rows);
  });
});

// Regression: the dedup above must NOT cover /workers — a refetch issued after
// a spawn would join a pre-spawn in-flight GET and apply a stale snapshot with
// the newest seq (useLive's guard can't reject a shared body).
describe("workers snapshot GETs are never dedup-shared", () => {
  it("concurrent listWorkers issue distinct requests, each with its own body", async () => {
    const preSpawn = [{ id: "orch" }];
    const postSpawn = [{ id: "orch" }, { id: "w-new", parent_id: "orch" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => preSpawn })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => postSpawn });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([api.listWorkers(), api.listWorkers()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a).toEqual(preSpawn);
    expect(b).toEqual(postSpawn);
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
