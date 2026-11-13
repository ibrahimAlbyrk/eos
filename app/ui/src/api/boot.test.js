import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./client.js";
import { endBoot, receiveBoot, takeBootHello, takeBootPart } from "./boot.js";

// What the Rust core puts in a snapshot (eos_contracts::BOOT_PARTS), then the focused
// chat's page (boot_page_target): each must be the very path its store asks, or the
// snapshot is never used.
const PARTS = [
  "/workers?brief=1",
  "/api/ui-config",
  "/api/settings",
  "/api/settings/compaction",
  "/pending",
  "/fs/recents",
  "/projects",
  "/api/profile",
  "/api/accounts",
  "/api/plugins",
];
const PAGE = "/workers/w-1/events?since=0&order=desc&limit=500";

const BODIES = {
  "/workers?brief=1": [{ id: "w-1" }],
  "/api/ui-config": { features: { pty: true } },
  "/api/settings": { settings: { "verbose.tools": true } },
  "/api/settings/compaction": { compaction: { threshold: 0.8 } },
  "/pending": [{ id: "p-1" }],
  "/fs/recents": { paths: ["/a"] },
  "/projects": { projects: [] },
  "/api/profile": { profile: { rev: 4 } },
  "/api/accounts": { accounts: [{ provider: "claude" }] },
  "/api/plugins": { plugins: [], installs: {} },
  [PAGE]: [{ id: 9, type: "user_message" }],
};

const snapshot = (bodies = BODIES) => ({
  hello: { epoch: "e1", seq: 7, caps: ["state:patch"] },
  parts: Object.fromEntries(Object.entries(bodies).map(([path, body]) => [path, { status: 200, body }])),
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ fetched: true }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  endBoot();
  vi.unstubAllGlobals();
});

// Every read a store makes at start-up, as it makes it.
const firstReads = () => Promise.all([
  api.listWorkers(),
  api.uiConfig(),
  api.getSettings(),
  api.getCompactionConfig(),
  api.listPending(),
  api.listRecents(),
  api.listProjects(),
  api.getProfile(),
  api.listAccounts(),
  api.listPlugins(),
  api.getWorkerEvents("w-1", { limit: 500, order: "desc", signal: new AbortController().signal }),
]);

describe("the boot snapshot", () => {
  it("answers each store's first read without a request", async () => {
    expect(PARTS.every((p) => p in BODIES)).toBe(true);
    expect(await receiveBoot(Promise.resolve(snapshot()))).toBe(true);
    const [workers, config, settings, compaction, pending, recents, projects, profile, accounts, plugins, page] =
      await firstReads();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workers).toEqual([{ id: "w-1" }]);
    expect(config).toEqual({ features: { pty: true } });
    expect(settings).toEqual({ "verbose.tools": true });
    expect(compaction).toEqual({ threshold: 0.8 });
    expect([pending, recents, projects]).toEqual([[{ id: "p-1" }], { paths: ["/a"] }, { projects: [] }]);
    expect([profile, accounts, plugins]).toEqual([{ rev: 4 }, [{ provider: "claude" }], { plugins: [], installs: {} }]);
    expect(page).toEqual([{ id: 9, type: "user_message" }]);
  });

  it("is read once: a later read asks the route", async () => {
    await receiveBoot(Promise.resolve(snapshot()));
    await api.getProfile();
    expect(await api.getProfile()).toBeUndefined(); // the mocked route's body has no profile
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/profile");
  });

  it("falls back to the routes for what it lacks, carried as an error, or after the stream took over", async () => {
    const { "/api/profile": _left, ...rest } = BODIES;
    const snap = snapshot(rest);
    snap.parts["/pending"] = { status: 500, body: { error: "x" } };
    await receiveBoot(Promise.resolve(snap));
    await api.getProfile();
    await api.listPending();
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/profile", "/pending"]);
    endBoot();
    await api.getSettings();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("no snapshot, or a failed one, leaves every read to its route", async () => {
    const failed = [() => undefined, () => Promise.resolve(null), () => Promise.reject(new Error("down")), () => Promise.resolve({})];
    for (const pending of failed) {
      expect(await receiveBoot(pending())).toBe(false);
    }
    await firstReads();
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("hands the stream position over once", async () => {
    await receiveBoot(Promise.resolve(snapshot()));
    expect(takeBootHello()).toEqual({ epoch: "e1", seq: 7, caps: ["state:patch"] });
    expect(takeBootHello()).toBeNull();
    expect(takeBootPart("/nope")).toBeNull();
  });
});
