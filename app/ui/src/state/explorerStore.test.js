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

describe("search mode routing", () => {
  it("files mode routes the debounced query to listFiles", async () => {
    vi.useFakeTimers();
    api.listFiles.mockResolvedValue({ entries: [{ name: "x.ts", absolutePath: "/root/x.ts", relativePath: "x.ts", type: "file" }] });
    explorer.setSearchQuery("x");
    await vi.advanceTimersByTimeAsync(150);
    expect(api.listFiles).toHaveBeenCalledWith(ROOT, "x");
    expect(api.symbolsSearch).not.toHaveBeenCalled();
    expect(explorer.getState().search.results).toHaveLength(1);
  });

  it("symbols mode routes the debounced query to symbolsSearch", async () => {
    vi.useFakeTimers();
    api.symbolsSearch.mockResolvedValue({ symbols: [occ("/root/x.ts", 4, { role: "definition" })] });
    explorer.setSearchMode("symbols");
    explorer.setSearchQuery("foo");
    await vi.advanceTimersByTimeAsync(150);
    expect(api.symbolsSearch).toHaveBeenCalledWith(ROOT, "foo");
    const s = explorer.getState().search;
    expect(s.results).toHaveLength(1);
    expect(s.results[0].line).toBe(4);
  });

  it("symbols mode marks results unavailable when the backend returns null", async () => {
    vi.useFakeTimers();
    api.symbolsSearch.mockResolvedValue(null);
    explorer.setSearchMode("symbols");
    explorer.setSearchQuery("foo");
    await vi.advanceTimersByTimeAsync(150);
    const s = explorer.getState().search;
    expect(s.results).toEqual([]);
    expect(s.unavailable).toBe(true);
  });
});
