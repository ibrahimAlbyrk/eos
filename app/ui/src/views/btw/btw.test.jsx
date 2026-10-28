import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const askSideQuestion = vi.fn();
vi.mock("../../api/client.js", () => ({
  api: { askSideQuestion: (...a) => askSideQuestion(...a) },
}));
// The markdown renderer sanitizes through DOMPurify, which needs a DOM.
vi.mock("../agents/messages/MessageAssistant.jsx", () => ({ MessageAssistant: ({ text }) => <div>{text}</div> }));

// The ui providers seed their state (the selected agent included) from localStorage.
const ls = new Map([["cm:selectedId", "w-1"]]);
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };

const { UiProvider } = await import("../../state/ui.jsx");
const { PaneScopeContext } = await import("../../state/paneScope.js");
const { applyDescriptors } = await import("../../lib/backendCaps.js");
const store = await import("../../state/sideQuestionStore.js");
const { SideQuestionPanel } = await import("./SideQuestionPanel.jsx");

applyDescriptors([
  { kind: "claude", capabilities: { sideQuestion: true } },
  { kind: "codex-cli", capabilities: {} },
]);

const live = (backendKind) => ({ workers: [{ id: "w-1", backend_kind: backendKind, cwd: "/repo" }] });
const render = (backendKind = "claude") => renderToStaticMarkup(
  <UiProvider><PaneScopeContext.Provider value="leaf-a"><SideQuestionPanel live={live(backendKind)} /></PaneScopeContext.Provider></UiProvider>,
);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  store._reset();
  askSideQuestion.mockReset();
});

describe("SideQuestionPanel", () => {
  it("invites a question when nothing has been asked yet", () => {
    const html = render();
    expect(text(html)).toContain("Ask on the side");
    expect(text(html)).toContain("Read-only · sees this chat · answers once");
    expect(html).not.toMatch(/<input[^>]*disabled/);
  });

  it("shows the question while it is being answered", () => {
    askSideQuestion.mockReturnValue(new Promise(() => {}));
    store.askSideQuestion("w-1", "why in memory?");
    const out = text(render());
    expect(out).toContain("why in memory?");
    expect(out).toContain("Thinking…");
  });

  it("shows the answer with its actions", async () => {
    askSideQuestion.mockResolvedValue({ ok: true, status: 200, body: { answer: "Each job has its own source." } });
    store.askSideQuestion("w-1", "why in memory?");
    await vi.waitFor(() => expect(store.getSideQuestion("w-1")?.status).toBe("done"));
    const out = text(render());
    expect(out).toContain("why in memory?");
    expect(out).toContain("Each job has its own source.");
    expect(out).toContain("Add to chat");
  });

  it("says so, and locks the field, for an agent that can't answer", () => {
    const html = render("codex-cli");
    expect(text(html)).toContain("Not available for this agent");
    expect(html).toMatch(/<input[^>]*disabled/);
  });
});
