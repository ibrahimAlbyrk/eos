import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { subscribe, getArchive, refreshArchived, selectArchived, toggleArchiveMode, _resetArchive } from "./archiveStore.js";

const okFetch = (body) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

// Real-Response semantics: the body is single-read, json() rejects the second
// time. Overlapping refetches (explicit + SSE tick) dedupe onto one request,
// so the client must share the PARSED result — these tests pin that.
const singleReadFetch = (body) =>
  vi.fn().mockImplementation(async () => {
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
  });

beforeEach(() => _resetArchive());
afterEach(() => vi.unstubAllGlobals());

describe("archiveStore", () => {
  it("refreshArchived populates rows and flips loaded", async () => {
    const rows = [{ id: "a", archived_at: 1 }];
    vi.stubGlobal("fetch", okFetch(rows));

    expect(getArchive().loaded).toBe(false);
    await refreshArchived();

    expect(getArchive().rows).toEqual(rows);
    expect(getArchive().loaded).toBe(true);
  });

  it("keeps the last snapshot when the fetch fails (daemon blip)", async () => {
    vi.stubGlobal("fetch", okFetch([{ id: "a", archived_at: 1 }]));
    await refreshArchived();
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => null }));
    await refreshArchived();

    expect(getArchive().rows).toEqual([{ id: "a", archived_at: 1 }]);
  });

  it("clears the selection when the selected row leaves the payload", async () => {
    vi.stubGlobal("fetch", okFetch([{ id: "a", archived_at: 1 }]));
    await refreshArchived();
    selectArchived("a");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", okFetch([]));
    await refreshArchived();

    expect(getArchive().selectedId).toBe(null);
    expect(getArchive().rows).toEqual([]);
  });

  it("restore: overlapping refetches (menu refetch + SSE tick) drop the restored row", async () => {
    vi.stubGlobal("fetch", okFetch([{ id: "a", archived_at: 1 }]));
    await refreshArchived();
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", singleReadFetch([]));
    await Promise.all([refreshArchived(), refreshArchived()]);

    expect(getArchive().rows).toEqual([]);
  });

  it("purge: overlapping refetches (menu refetch + SSE tick) drop the purged row and its selection", async () => {
    vi.stubGlobal("fetch", okFetch([{ id: "a", archived_at: 1 }, { id: "b", archived_at: 2 }]));
    await refreshArchived();
    selectArchived("a");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", singleReadFetch([{ id: "b", archived_at: 2 }]));
    await Promise.all([refreshArchived(), refreshArchived()]);

    expect(getArchive().rows).toEqual([{ id: "b", archived_at: 2 }]);
    expect(getArchive().selectedId).toBe(null);
  });

  it("archive of a live agent: overlapping refetches (mount + SSE tick) surface the new row", async () => {
    vi.stubGlobal("fetch", singleReadFetch([{ id: "a", archived_at: 1 }]));
    await Promise.all([refreshArchived(), refreshArchived()]);

    expect(getArchive().rows).toEqual([{ id: "a", archived_at: 1 }]);
    expect(getArchive().loaded).toBe(true);
  });

  it("selectArchived updates the snapshot and notifies subscribers", async () => {
    vi.stubGlobal("fetch", okFetch([{ id: "a", archived_at: 1 }]));
    await refreshArchived();
    const cb = vi.fn();
    subscribe(cb);

    selectArchived("a");

    expect(getArchive().selectedId).toBe("a");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("getArchive returns a stable reference between emits (useSyncExternalStore contract)", () => {
    expect(getArchive()).toBe(getArchive());
  });

  it("toggleArchiveMode flips the mode and notifies subscribers", () => {
    const cb = vi.fn();
    subscribe(cb);

    expect(getArchive().archiveMode).toBe(false);
    toggleArchiveMode();
    expect(getArchive().archiveMode).toBe(true);
    toggleArchiveMode();
    expect(getArchive().archiveMode).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("toggling the mode leaves rows and selection untouched (toggle-off restores as-is)", async () => {
    vi.stubGlobal("fetch", okFetch([{ id: "a", archived_at: 1 }]));
    await refreshArchived();
    selectArchived("a");

    toggleArchiveMode();
    toggleArchiveMode();

    expect(getArchive().rows).toEqual([{ id: "a", archived_at: 1 }]);
    expect(getArchive().selectedId).toBe("a");
  });
});
