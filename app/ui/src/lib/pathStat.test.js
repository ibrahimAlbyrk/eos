import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = { statPath: vi.fn(), statPaths: vi.fn() };
vi.mock("../api/client.js", () => ({ api }));

const file = (abs) => ({ absolutePath: abs, type: "file", size: 1, mtimeMs: 1, isSymlink: false, readonly: false });
const answer = (abs) => (abs.includes("missing") ? { status: 404, body: { error: "not found" } }
  : abs.includes("broken") ? { status: 500, body: { error: "x" } }
    : { status: 200, body: file(abs) });

// A fresh module per test: the cache and the batch route's state are module-wide.
let pathStat;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  api.statPath.mockReset().mockImplementation(async (abs) => {
    const a = answer(abs);
    if (a.status !== 200) throw new Error(`stat → ${a.status}`);
    return a.body;
  });
  api.statPaths.mockReset().mockImplementation(async (paths) => paths.map(answer));
  pathStat = await import("./pathStat.js");
});
afterEach(() => vi.useRealTimers());

const frame = () => vi.advanceTimersByTimeAsync(20);

describe("statPath", () => {
  it("sends the asks of one frame in one request and answers each path as its own stat would", async () => {
    const paths = ["/p/a.txt", "/p/missing.md", "/p/broken", "/p/b.txt"];
    const answers = Promise.all(paths.map(pathStat.statPath));
    await frame();
    expect(await answers).toEqual([file("/p/a.txt"), null, undefined, file("/p/b.txt")]);
    expect(api.statPaths).toHaveBeenCalledTimes(1);
    expect(api.statPaths).toHaveBeenCalledWith(paths);
    expect(api.statPath).not.toHaveBeenCalled();
    // Remembered as before: known at once, fresh for a while, unknown stays unknown.
    expect(pathStat.knownStat("/p/missing.md")).toBeNull();
    expect(pathStat.knownStat("/p/broken")).toBeUndefined();
    expect(pathStat.isFresh("/p/a.txt")).toBe(true);
    await pathStat.statPath("/p/a.txt");
    expect(api.statPaths).toHaveBeenCalledTimes(1);
  });

  it("asks one path in flight once, and a lone path with the single stat", async () => {
    const twice = [pathStat.statPath("/p/a.txt"), pathStat.statPath("/p/a.txt")];
    await frame();
    expect(await Promise.all(twice)).toEqual([file("/p/a.txt"), file("/p/a.txt")]);
    expect(api.statPath).toHaveBeenCalledTimes(1);
    expect(api.statPaths).not.toHaveBeenCalled();
  });

  it("a daemon without the batch route is asked one path at a time from then on", async () => {
    api.statPaths.mockResolvedValue(null);
    const first = Promise.all([pathStat.statPath("/p/a.txt"), pathStat.statPath("/p/missing")]);
    await frame();
    expect(await first).toEqual([file("/p/a.txt"), null]);
    const later = Promise.all([pathStat.statPath("/p/b.txt"), pathStat.statPath("/p/c.txt")]);
    await frame();
    await later;
    expect(api.statPaths).toHaveBeenCalledTimes(1);
    expect(api.statPath).toHaveBeenCalledTimes(4);
  });

  it("an unreachable daemon leaves the answers unknown and keeps an older one", async () => {
    const first = Promise.all([pathStat.statPath("/p/a.txt"), pathStat.statPath("/p/b.txt")]);
    await frame();
    await first;
    vi.advanceTimersByTime(10_000);
    api.statPaths.mockRejectedValue(new Error("stat → 0"));
    const again = Promise.all([pathStat.statPath("/p/a.txt"), pathStat.statPath("/p/new")]);
    await frame();
    expect(await again).toEqual([file("/p/a.txt"), undefined]);
  });

  it("splits more paths than one request may carry", async () => {
    const paths = Array.from({ length: 450 }, (_, i) => `/p/f${i}`);
    const answers = Promise.all(paths.map(pathStat.statPath));
    await frame();
    expect((await answers).every((s) => s?.type === "file")).toBe(true);
    expect(api.statPaths.mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 50]);
  });
});
