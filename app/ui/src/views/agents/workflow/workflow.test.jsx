import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getWorkflowRun = vi.fn();
vi.mock("../../../api/client.js", () => ({
  api: {
    getWorkflowRun: (...a) => getWorkflowRun(...a),
    getWorkflowAgentRows: async () => null,
    stopWorkflowRun: async () => ({ ok: true }),
  },
}));
// The markdown renderer sanitizes through DOMPurify, which needs a DOM.
vi.mock("../messages/MessageAssistant.jsx", () => ({ MessageAssistant: ({ text }) => <div>{text}</div> }));

// The ui providers seed their state from localStorage in render-time initializers.
const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };

const { UiProvider } = await import("../../../state/ui.jsx");
const { PaneScopeContext } = await import("../../../state/paneScope.js");
const store = await import("../../../state/workflowRunsStore.js");
const { WorkflowCard } = await import("./WorkflowCard.jsx");
const { WorkflowPanel } = await import("./WorkflowPanel.jsx");

const render = (node) => renderToStaticMarkup(<UiProvider><PaneScopeContext.Provider value="leaf-a">{node}</PaneScopeContext.Provider></UiProvider>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const SCRIPT = "export const meta = {\n  name: 'review-changes',\n  description: 'Review changed files',\n  phases: [{ title: 'Scope' }, { title: 'Review' }, { title: 'Verify' }],\n}\n";
const tool = { id: "wf1", name: "Workflow", input: { script: SCRIPT }, ts: Date.now(), result: { text: "Workflow launched", isError: false } };
const agents = [
  { index: 1, label: "scope:diff", phaseIndex: 1, agentId: "aaaaaa1", state: "done", resultPreview: "14 files", durationMs: 38_000 },
  { index: 2, label: "review:bugs", phaseIndex: 2, agentId: "aaaaaa2", state: "running", startedAt: Date.now() - 5_000, lastToolName: "Grep", lastToolSummary: "replaces", promptPreview: "Review for bugs", tokens: 12_000 },
];
const snapshot = { phases: [{ index: 1, title: "Scope" }, { index: 2, title: "Review" }], agents, logs: [] };
const started = { taskId: "t1", name: "review-changes", description: "Review changed files", ts: Date.now() - 60_000 };

beforeEach(() => {
  store._reset();
  getWorkflowRun.mockReset();
});

describe("WorkflowCard", () => {
  it("a running run: its phases, its agents and what they are doing", () => {
    store.applyWorkflowProgress({ workerId: "w-1", callId: "wf1", taskId: "t1", status: "running", snapshot, updatedAt: 1 });
    const t = text(render(<WorkflowCard block={{ kind: "workflow", tool, started, completed: null }} workerId="w-1" workers={[]} />));
    expect(t).toContain("Running workflow review-changes");
    expect(t).toContain("Review changed files");
    for (const phase of ["Scope", "Review", "Verify"]) expect(t).toContain(phase);
    expect(t).toContain("review:bugs");
    expect(t).toContain("Searching replaces");
    expect(t).toContain("Open live view");
    expect(t).not.toContain("Stop");
  });

  it("offers Stop once the daemon says the session can", async () => {
    getWorkflowRun.mockResolvedValue({ callId: "wf1", taskId: "t1", status: "running", snapshot, canStop: true });
    await store.fetchWorkflowRun("w-1", "wf1");
    const html = render(<WorkflowCard block={{ kind: "workflow", tool, started, completed: null }} workerId="w-1" workers={[]} />);
    expect(html).toContain('aria-label="Stop workflow"');
  });

  it("a finished run shows the script's log", async () => {
    getWorkflowRun.mockResolvedValue({ callId: "wf1", taskId: "t1", status: "completed", snapshot: { ...snapshot, logs: ["Review: 3 findings"] }, canStop: false });
    await store.fetchWorkflowRun("w-1", "wf1");
    const completed = { status: "completed", taskId: "t1", snapshot, ts: Date.now() };
    const t = text(render(<WorkflowCard block={{ kind: "workflow", tool, started, completed }} workerId="w-1" workers={[]} />));
    expect(t).toContain("Ran workflow review-changes");
    expect(t).toContain("Review: 3 findings");
  });

  it("a call the daemon never reported on falls back to its tool row", async () => {
    getWorkflowRun.mockResolvedValue(null);
    await store.fetchWorkflowRun("w-1", "wf1");
    const old = { ...tool, ts: Date.now() - 3_600_000 };
    const t = text(render(<WorkflowCard block={{ kind: "workflow", tool: old, started: null, completed: null }} workerId="w-1" workers={[]} />));
    expect(t).toContain("Started workflow");
    expect(t).not.toContain("Open live view");
  });
});

describe("WorkflowPanel", () => {
  it("phases as columns, the working agent open below", async () => {
    getWorkflowRun.mockResolvedValue({ callId: "wf1", taskId: "t1", runId: "wf_1", name: "review-changes", status: "running", snapshot, canStop: false });
    await store.fetchWorkflowRun("w-1", "wf1");
    store.noteWorkflowCall("w-1", "wf1", tool);
    const html = render(<WorkflowPanel tabId="workflow:w-1/wf1" live={{ workers: [] }} />);
    const t = text(html);
    expect(t).toContain("review-changes");
    expect(t).toContain("wf_1");
    expect(html.match(/class="wr-col /g)).toHaveLength(3);
    expect(html).toMatch(/wr-node is-selected[^>]*>.*review:bugs/);
    expect(t).toContain("Task Review for bugs");
  });

  it("a run the daemon doesn't know offers to close the tab", async () => {
    getWorkflowRun.mockResolvedValue(null);
    await store.fetchWorkflowRun("w-1", "gone");
    expect(text(render(<WorkflowPanel tabId="workflow:w-1/gone" live={{ workers: [] }} />))).toContain("no longer available");
  });
});
