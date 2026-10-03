import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { PAGE_TOOL_VIEWS } from "./PageToolViews.jsx";

// DOMPurify needs a DOM; the node test env has none, so render unsanitized.
vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const render = (el) => renderToStaticMarkup(<UiProvider>{el}</UiProvider>);
const ok = (obj) => ({ isError: false, text: JSON.stringify(obj) });

describe("page tool views", () => {
  it("a tick reads as one line: task chip, page chip, nothing to expand", () => {
    const v = PAGE_TOOL_VIEWS.set_page_task;
    const tool = { input: { id: "pg-abcdef12", task: "Clamp hip offset on stairs", done: true }, result: ok({ id: "pg-abcdef12", rev: 3 }) };
    expect(v.label(tool)).toEqual({ verb: "Ticked", file: "" });
    expect(v.expandable(tool)).toBe(false);
    const html = render(v.headerBadge(tool));
    expect(html).toContain("Clamp hip offset on stairs");
    expect(html).toContain("ptl-chip");
  });

  it("a listing names its count and opens to page rows", () => {
    const v = PAGE_TOOL_VIEWS.list_pages;
    const tool = { input: { query: "stance" }, result: ok({ pages: [{ id: "pg-1", title: "Stance notes", excerpt: "feet", openTasks: 2, doneTasks: 2, updatedAt: new Date().toISOString() }] }) };
    expect(v.label(tool).file).toBe("1 page for “stance”");
    expect(render(<v.Detail tool={tool} />)).toContain("2/4");
  });

  it("an edit draws a word diff in a page card", () => {
    const v = PAGE_TOOL_VIEWS.edit_page;
    const tool = { input: { id: "pg-1", old_text: "spherecast, not raycast", new_text: "spherecast, raycast as fallback" }, result: ok({ id: "pg-1", rev: 13 }) };
    const html = render(<v.Detail tool={tool} />);
    expect(html).toContain("<del>");
    expect(html).toContain("<ins>");
    expect(html).toContain("rev 13");
    expect(html).toContain("Open page");
  });

  it("an append shows the added lines, tasks as checkboxes", () => {
    const v = PAGE_TOOL_VIEWS.append_to_page;
    const tool = { input: { id: "pg-1", text: "Hip snaps on the last step.\n- [ ] Raise MaxHipDrop", under_heading: "Findings" }, result: ok({ id: "pg-1", rev: 12 }) };
    const html = render(<v.Detail tool={tool} />);
    expect(html).toContain("+2 lines");
    expect(html).toContain("under Findings");
    expect(html).toContain("ptl-cb");
    expect(html).toContain("Raise MaxHipDrop");
  });

  it("a read shows the page's header from the tool text", () => {
    const v = PAGE_TOOL_VIEWS.read_page;
    const text = "# Stance notes\n(page pg-1 · rev 10 · last edited 2026-10-03T14:55:03.291Z by the user)\n\n- [ ] asda";
    const tool = { input: { id: "pg-1" }, result: { isError: false, text } };
    const html = render(<v.Detail tool={tool} />);
    expect(html).toContain("Stance notes");
    expect(html).toContain("rev 10");
    expect(html).toContain("by you");
  });
});
