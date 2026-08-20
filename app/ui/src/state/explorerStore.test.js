import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    listFiles: vi.fn(async () => ({ entries: [] })),
    watchDir: vi.fn(async () => ({})),
    unwatchDir: vi.fn(async () => ({})),
    unwatchAll: vi.fn(async () => ({})),
    symbolsSearch: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import { explorer, _resetForTest } from "./explorerStore.js";

const ROOT = "/root";
const occ = (path, line, extra = {}) => ({ name: "foo", kind: "function", role: "reference", path, line, column: 1, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  api.listFiles.mockResolvedValue({ entries: [] });
  _resetForTest();
  explorer.setRoot(ROOT);
});

afterEach(() => vi.useRealTimers());

describe("combined search", () => {
  it("queries both listFiles and symbolsSearch and stores both result sets", async () => {
    vi.useFakeTimers();
    api.listFiles.mockResolvedValue({ entries: [{ name: "x.ts", absolutePath: "/root/x.ts", relativePath: "x.ts", type: "file" }] });
    api.symbolsSearch.mockResolvedValue({ symbols: [occ("/root/x.ts", 4, { role: "definition" })] });
    explorer.setSearchQuery("x");
    await vi.advanceTimersByTimeAsync(150);
    expect(api.listFiles).toHaveBeenCalledWith(ROOT, "x", { includeHidden: true });
    expect(api.symbolsSearch).toHaveBeenCalledWith(ROOT, "x");
    const r = explorer.getState().search.results;
    expect(r.files).toHaveLength(1);
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0].line).toBe(4);
  });

  it("flags symbols unavailable when the backend returns null but keeps file matches", async () => {
    vi.useFakeTimers();
    api.listFiles.mockResolvedValue({ entries: [{ name: "x.ts", absolutePath: "/root/x.ts", relativePath: "x.ts", type: "file" }] });
    api.symbolsSearch.mockResolvedValue(null);
    explorer.setSearchQuery("x");
    await vi.advanceTimersByTimeAsync(150);
    const s = explorer.getState().search;
    expect(s.results.symbols).toEqual([]);
    expect(s.results.files).toHaveLength(1);
    expect(s.symbolsUnavailable).toBe(true);
  });

  it("clearing the query resets results to null", async () => {
    vi.useFakeTimers();
    api.listFiles.mockResolvedValue({ entries: [{ name: "x.ts", absolutePath: "/root/x.ts", relativePath: "x.ts", type: "file" }] });
    explorer.setSearchQuery("x");
    await vi.advanceTimersByTimeAsync(150);
    explorer.setSearchQuery("");
    expect(explorer.getState().search.results).toBeNull();
  });
});
