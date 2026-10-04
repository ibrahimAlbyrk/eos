import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../../api/client.js", () => ({ api: { listUserMemories: vi.fn() } }));

import { api } from "../../../api/client.js";
import { UiProvider } from "../../../state/ui.jsx";
import { _resetUserMemories, refreshUserMemories } from "../../../state/userMemoryStore.js";
import { MEMORY_TOOL_VIEWS, parseSearchResult, parseSuggestResult } from "./MemoryToolViews.jsx";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const render = (el) => renderToStaticMarkup(<UiProvider>{el}</UiProvider>);
const text = (t) => ({ isError: false, text: t });
const memory = (over = {}) => ({
  id: "um-abc12345", text: "Prefers pnpm over npm.", category: "stack", scope: { kind: "project", path: "/Users/me/eos" },
  tier: "always", status: "suggested", source: { kind: "agent", agentId: "w-1", agentName: "x" },
  rev: 0, createdAt: 1, updatedAt: 1, ...over,
});
const suggestion = {
  input: { text: "Prefers pnpm over npm.", category: "stack", scope: "project", why: "switched the lockfile twice" },
  result: text("Suggested (um-abc12345). The user reviews it in Eos before it is remembered — no need to mention it."),
};

async function withMemories(list) {
  api.listUserMemories.mockResolvedValue(list);
  await refreshUserMemories();
}

beforeEach(() => _resetUserMemories());

describe("memory tool results", () => {
  it("parses suggestions, with or without an id, and duplicates", () => {
    expect(parseSuggestResult(suggestion.result.text)).toEqual({ id: "um-abc12345", duplicate: false, knownText: null });
    expect(parseSuggestResult('Already known (um-x1): "Use pnpm.". Nothing to do.')).toEqual({ id: "um-x1", duplicate: true, knownText: "Use pnpm." });
    expect(parseSuggestResult("Suggested. The user reviews it…")).toMatchObject({ id: null, duplicate: false });
    expect(parseSuggestResult("boom")).toBe(null);
  });

  it("parses search hits and their project mark", () => {
    expect(parseSearchResult("- (this project) Never restart.\n- Be terse.")).toEqual([
      { text: "Never restart.", project: true },
      { text: "Be terse.", project: false },
    ]);
    expect(parseSearchResult("No memories match.")).toEqual([]);
  });
});

describe("search_memory view", () => {
  const v = MEMORY_TOOL_VIEWS.search_memory;

  it("names the query and counts hits; nothing found doesn't open", () => {
    const hit = { input: { query: "commit style" }, result: text("- Commit only when asked.") };
    expect(v.label(hit)).toEqual({ verb: "Searched memory for", file: "“commit style”" });
    expect(render(v.headerBadge(hit))).toContain("1 found");
    expect(v.expandable(hit)).toBe(true);
    const none = { input: { query: "" }, result: text("No memories match.") };
    expect(v.label(none).file).toBe("recent memories");
    expect(render(v.headerBadge(none))).toContain("nothing found");
    expect(v.expandable(none)).toBe(false);
  });

  it("opens to the memories it found", () => {
    const html = render(<v.Detail tool={{ input: { query: "x" }, result: text("- (this project) Never restart.\n- Be terse.") }} />);
    expect(html).toContain("Never restart.");
    expect(html).toContain("this project");
    expect(html.match(/class="ptl-row mtl-row"/g)).toHaveLength(2);
  });
});

describe("suggest_memory view", () => {
  const v = MEMORY_TOOL_VIEWS.suggest_memory;

  it("header quotes the memory", () => {
    expect(v.label(suggestion)).toEqual({ verb: "Suggested a memory", file: "“Prefers pnpm over npm.”" });
    expect(v.expandable(suggestion)).toBe(true);
  });

  it("waiting: Keep / Dismiss in the card, the pill says so", async () => {
    await withMemories([memory()]);
    expect(render(v.headerBadge(suggestion))).toContain("Waiting for you");
    const html = render(<v.Detail tool={suggestion} />);
    expect(html).toContain("Memory suggestion");
    expect(html).toContain("Stack · eos");
    expect(html).toContain("switched the lockfile twice");
    expect(html).toContain(">Keep<");
    expect(html).toContain(">Dismiss<");
  });

  it("kept: the outcome replaces the buttons", async () => {
    await withMemories([memory({ status: "active" })]);
    expect(render(v.headerBadge(suggestion))).toContain("Kept");
    const html = render(<v.Detail tool={suggestion} />);
    expect(html).toContain("in every new agent");
    expect(html).not.toContain(">Keep<");
  });

  it("gone from the store: dismissed", async () => {
    await withMemories([]);
    expect(render(v.headerBadge(suggestion))).toContain("Dismissed");
  });

  it("a duplicate shows what was already remembered", async () => {
    await withMemories([]);
    const dup = { ...suggestion, result: text('Already known (um-old00000): "Use pnpm, not npm.". Nothing to do.') };
    expect(render(v.headerBadge(dup))).toContain("Already known");
    const html = render(<v.Detail tool={dup} />);
    expect(html).toContain("Already remembered");
    expect(html).toContain("Use pnpm, not npm.");
  });
});
