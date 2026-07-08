import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    watchDir: vi.fn(async () => ({})),
    unwatchDir: vi.fn(async () => ({})),
  },
}));

import { api } from "../api/client.js";
import { emitFsChange } from "./fsChangeBus.js";
import { watchFile, resubscribe, _resetForTest } from "./fileWatchStore.js";

const DIR = "/root/sub";
const A = "/root/sub/a.ts";
const B = "/root/sub/b.ts";

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
});

describe("fileWatchStore ref-count", () => {
  it("two subscribers in the same dir arm a single watchDir(dir, dir)", () => {
    const off1 = watchFile(A, {});
    const off2 = watchFile(B, {});
    expect(api.watchDir).toHaveBeenCalledTimes(1);
    expect(api.watchDir).toHaveBeenCalledWith(DIR, DIR);
    expect(api.unwatchDir).not.toHaveBeenCalled();
    off1();
    off2();
  });

  it("unwatches only when the last subscriber for the dir leaves", () => {
    const off1 = watchFile(A, {});
    const off2 = watchFile(B, {});
    off1();
    expect(api.unwatchDir).not.toHaveBeenCalled();
    off2();
    expect(api.unwatchDir).toHaveBeenCalledTimes(1);
    expect(api.unwatchDir).toHaveBeenCalledWith(DIR, DIR);
  });
});

describe("fileWatchStore per-path fan-out", () => {
  it("routes change to the matching path's onChange only", () => {
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    watchFile(A, { onChange: onChangeA });
    watchFile(B, { onChange: onChangeB });
    emitFsChange({ changes: [{ kind: "change", path: A, dir: DIR }] });
    expect(onChangeA).toHaveBeenCalledTimes(1);
    expect(onChangeB).not.toHaveBeenCalled();
  });

  it("routes unlink to onRemove, not onChange", () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    watchFile(A, { onChange, onRemove });
    emitFsChange({ changes: [{ kind: "unlink", path: A, dir: DIR }] });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fans a single change out to every subscriber of the same path", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    watchFile(A, { onChange: h1 });
    watchFile(A, { onChange: h2 });
    emitFsChange({ changes: [{ kind: "change", path: A, dir: DIR }] });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unsubscribe", () => {
    const onChange = vi.fn();
    const off = watchFile(A, { onChange });
    off();
    emitFsChange({ changes: [{ kind: "change", path: A, dir: DIR }] });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("fileWatchStore resubscribe", () => {
  it("re-arms every active dir watch once after a reconnect", () => {
    watchFile(A, {});
    watchFile("/root/other/c.ts", {});
    api.watchDir.mockClear();
    resubscribe();
    expect(api.watchDir).toHaveBeenCalledTimes(2);
    expect(api.watchDir).toHaveBeenCalledWith(DIR, DIR);
    expect(api.watchDir).toHaveBeenCalledWith("/root/other", "/root/other");
  });
});
