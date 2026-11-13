import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { endBoot, receiveBoot } from "../api/boot.js";
import { primeFromBoot } from "./bootPrime.js";
import { attach, getSnapshot } from "./eventsStore.js";
import { getAccountsState } from "./accountsStore.js";
import { getProfileState } from "./profileStore.js";
import { getProjectsState } from "./projectsStore.js";
import { getFeatures } from "./featuresStore.js";

const PAGE = (id) => `/workers/${id}/events?since=0&order=desc&limit=500`;
const row = (id, workerId) => ({ id, worker_id: workerId, ts: id * 10, type: "jsonl" });

const snapshot = (chat) => ({
  hello: { epoch: "e1", seq: 3, caps: [] },
  parts: {
    "/api/ui-config": { status: 200, body: { features: { remote: false } } },
    "/api/accounts": { status: 200, body: { accounts: [{ provider: "claude" }] } },
    "/api/profile": { status: 200, body: { profile: { rev: 4 } } },
    "/projects": { status: 200, body: { projects: [{ id: "p1" }] } },
    [PAGE(chat)]: { status: 200, body: [row(1, chat), row(2, chat)] },
  },
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  endBoot();
  vi.unstubAllGlobals();
});

describe("primeFromBoot", () => {
  it("fills what the first screen reads from the snapshot, without a request", async () => {
    await receiveBoot(Promise.resolve(snapshot("w-boot1")));
    await primeFromBoot();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccountsState().accounts).toEqual([{ provider: "claude" }]);
    expect(getProfileState().profile).toEqual({ rev: 4 });
    expect(getProjectsState().projects).toEqual([{ id: "p1" }]);
    expect(getFeatures().remote).toBe(false);
    const snap = getSnapshot("w-boot1");
    expect([snap.eventsFor, snap.events.map((e) => e.id)]).toEqual(["w-boot1", [1, 2]]);
    // Its transcript attaches without asking again while the snapshot stands.
    const onNewest = vi.fn();
    const detach = attach("w-boot1", { onNewest });
    expect(onNewest).toHaveBeenCalledWith("w-boot1", snap.events);
    expect(fetchMock).not.toHaveBeenCalled();
    detach();
  });

  it("once the stream took over, a primed window is caught up like any cached one", async () => {
    await receiveBoot(Promise.resolve(snapshot("w-boot2")));
    await primeFromBoot();
    endBoot();
    const detach = attach("w-boot2");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/workers/w-boot2/events?since=0&order=asc&limit=500&afterId=2");
    detach();
  });

  it("without a snapshot it does nothing", async () => {
    await primeFromBoot();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
