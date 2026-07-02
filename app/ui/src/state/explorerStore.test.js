import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    listFiles: vi.fn(async () => ({ entries: [] })),
    watchDir: vi.fn(async () => ({})),
    unwatchDir: vi.fn(async () => ({})),
    unwatchAll: vi.fn(async () => ({})),
    symbolsSearch: vi.fn(),
    symbolsLookup: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import { explorer, _resetForTest } from "./explorerStore.js";

const ROOT = "/root";
const FROM = "/root/a.ts";
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

describe("goToDefinition", () => {
  it("one definition opens the file and sets a reveal target", async () => {
    api.symbolsLookup.mockResolvedValue({ occurrences: [occ("/root/def.ts", 12, { role: "definition" })] });
    await explorer.goToDefinition("foo", FROM);
    const st = explorer.getState();
    expect(st.openPath).toBe("/root/def.ts");
    expect(st.reveal).toMatchObject({ path: "/root/def.ts", line: 12 });
    expect(st.refs).toBeNull(); // single hit → no panel
  });

  it("several definitions open the picker panel instead of a file", async () => {
    api.symbolsLookup.mockResolvedValue({ occurrences: [occ("/root/a.ts", 1, { role: "definition" }), occ("/root/b.ts", 2, { role: "definition" })] });
    await explorer.goToDefinition("foo", FROM);
    const st = explorer.getState();
    expect(st.openPath).toBeNull();
    expect(st.refs).toMatchObject({ name: "foo", want: "definitions" });
    expect(st.refs.occurrences).toHaveLength(2);
  });

  it("indexing shows the panel in an indexing state", async () => {
    api.symbolsLookup.mockResolvedValue({ occurrences: [], indexing: true });
    await explorer.goToDefinition("foo", FROM);
    expect(explorer.getState().refs).toMatchObject({ indexing: true, want: "definitions" });
  });

  it("a null result (backend absent) is a quiet no-op", async () => {
    api.symbolsLookup.mockResolvedValue(null);
    await explorer.goToDefinition("foo", FROM);
    const st = explorer.getState();
    expect(st.refs).toBeNull();
    expect(st.openPath).toBeNull();
  });
});

describe("findReferences", () => {
  it("populates the references panel grouped-ready", async () => {
    api.symbolsLookup.mockResolvedValue({ occurrences: [occ("/root/a.ts", 1), occ("/root/a.ts", 5)] });
    await explorer.findReferences("foo", FROM);
    const refs = explorer.getState().refs;
    expect(api.symbolsLookup).toHaveBeenCalledWith(ROOT, "foo", "references", FROM);
    expect(refs).toMatchObject({ name: "foo", want: "references", loading: false });
    expect(refs.occurrences).toHaveLength(2);
  });

  it("closes the panel (quiet no-op) when the backend returns null", async () => {
    api.symbolsLookup.mockResolvedValue(null);
    await explorer.findReferences("foo", FROM);
    expect(explorer.getState().refs).toBeNull();
  });

  it("closeRefs clears the panel", async () => {
    api.symbolsLookup.mockResolvedValue({ occurrences: [occ("/root/a.ts", 1)] });
    await explorer.findReferences("foo", FROM);
    expect(explorer.getState().refs).not.toBeNull();
    explorer.closeRefs();
    expect(explorer.getState().refs).toBeNull();
  });
});

describe("typing a search dismisses the refs panel", () => {
  it("clears refs when a query is entered", async () => {
    vi.useFakeTimers();
    api.symbolsLookup.mockResolvedValue({ occurrences: [occ("/root/a.ts", 1)] });
    await explorer.findReferences("foo", FROM);
    expect(explorer.getState().refs).not.toBeNull();
    explorer.setSearchQuery("bar");
    expect(explorer.getState().refs).toBeNull();
  });
});
