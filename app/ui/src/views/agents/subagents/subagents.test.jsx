import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";
import { collectSubagents } from "../../../lib/subagentRuns.js";
import { SubagentLine } from "./SubagentLine.jsx";
import { SubagentBatch } from "./SubagentBatch.jsx";
import { SubagentList } from "./SubagentList.jsx";
import { SubagentDetail } from "./SubagentDetail.jsx";

// The markdown renderer sanitizes through DOMPurify, which needs a DOM the node
// env lacks; the report's text is what these tests check.
vi.mock("../messages/MessageAssistant.jsx", () => ({
  MessageAssistant: ({ text }) => <div className="msg-asst">{text}</div>,
}));

// The ui providers seed their state from localStorage in render-time
// initializers; the node test env has none.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const NOW = 100_000;
const read = (id, running) => ({ id, name: "Read", input: { file_path: "/p/src/Movement2D.cs" }, result: running ? null : { text: "x", isError: false }, done: !running, running, ts: 60_000 });
const runs = collectSubagents([
  { kind: "agentRun", toolUseId: "git", description: "Git özeti", prompt: "git kontrolleri", status: "completed", ts: 59_000, endTs: 75_000, tools: [], result: "Dal: main", usage: null, model: null, subagentType: "Explore" },
  { kind: "agentRun", toolUseId: "files", description: "Dosya özeti", prompt: "dosyaları oku", status: "running", ts: 59_000, endTs: null, tools: [read("r1", true)], result: null, usage: null, model: null, subagentType: null },
  { kind: "agentRun", toolUseId: "unity", description: "Unity sürümü", prompt: "sürümü bul", status: "completed", ts: 59_000, endTs: 93_000, tools: [read("r2", false)], result: "Editör `6000.0.23f1`.\n<usage>tokens: 9</usage>", usage: null, model: "claude-sonnet-4-5", effort: "high", subagentType: "Explore" },
]);
const byId = (id) => runs.find((r) => r.toolUseId === id);

const render = (node) => renderToStaticMarkup(
  <UiProvider><PaneScopeContext.Provider value="leaf-a">{node}</PaneScopeContext.Provider></UiProvider>,
);
const text = (html) => html.replace(/<[^>]+>/g, "");

describe("SubagentLine", () => {
  it("reads as one sentence with a glyph per subagent", () => {
    const html = render(<SubagentLine runs={runs} workerId="w1" />);
    expect(text(html)).toBe("Git özeti, Dosya özeti and Unity sürümü started working");
    expect(html.match(/class="sa-glyph/g)).toHaveLength(3);
    expect(html.match(/class="sa-name/g)).toHaveLength(3);
  });

  it("marks a running subagent's glyph live and colors each with its identity", () => {
    const html = render(<SubagentLine runs={[byId("files")]} workerId="w1" />);
    expect(html).toContain("sa-glyph is-live");
    expect(html).toContain(`--sa:${byId("files").identity.hex}`);
  });
});

describe("SubagentBatch", () => {
  const crowd = (n) => collectSubagents(Array.from({ length: n }, (_, i) => (
    { kind: "agentRun", toolUseId: `t${i}`, description: `Topic ${i}`, status: i % 2 ? "completed" : "running", ts: 59_000, endTs: i % 2 ? 70_000 : null, tools: [], usage: null }
  )));

  it("keeps a few subagents as a sentence of names", () => {
    expect(text(render(<SubagentBatch runs={runs} workerId="w1" />))).toBe("Git özeti, Dosya özeti and Unity sürümü started working");
  });

  it("folds a crowd into one closed summary row", () => {
    const html = render(<SubagentBatch runs={crowd(5)} workerId="w1" />);
    expect(text(html)).toBe("5 subagents started working3 running · 2 done");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("sa-rail-row");
  });

  it("shows six glyphs and counts the rest", () => {
    const html = render(<SubagentBatch runs={crowd(9)} workerId="w1" />);
    expect(html.match(/class="sa-glyph/g)).toHaveLength(6);
    expect(html).toContain(">+3<");
  });
});

describe("SubagentList", () => {
  it("shows what each active subagent is doing and how long it has worked", () => {
    const html = render(<SubagentList runs={runs} now={NOW} onOpen={() => {}} />);
    expect(html).toContain("Active · 1");
    expect(html).toContain("Reading Movement2D.cs");
    expect(html).toContain("41s");
    expect(html).toContain("Done · 2");
    // most recent finisher first
    expect(html.indexOf("Unity sürümü")).toBeLessThan(html.indexOf("Git özeti"));
  });

  it("says so when nothing is running, and has an empty state", () => {
    expect(render(<SubagentList runs={[byId("git")]} now={NOW} onOpen={() => {}} />)).toContain("No active subagents");
    expect(render(<SubagentList runs={[]} now={NOW} onOpen={() => {}} />)).toContain("No subagents yet");
  });
});

describe("SubagentDetail", () => {
  it("leads a finished subagent with its report, work folded away", () => {
    const html = render(<SubagentDetail run={byId("unity")} now={NOW} workers={[]} onBack={() => {}} />);
    expect(html).toContain("Unity sürümü");
    expect(html).toContain("Explore · Sonnet 4.5 · High");
    expect(html).toContain("Worked for 34s");
    expect(html).toContain("6000.0.23f1");
    expect(html).not.toContain("tokens: 9");
    expect(html).not.toContain("sürümü bul");
  });

  it("opens a running subagent on its prompt and live tools", () => {
    const html = render(<SubagentDetail run={byId("files")} now={NOW} workers={[]} onBack={() => {}} />);
    expect(html).toContain("Working for 41s");
    expect(html).toContain("dosyaları oku");
    expect(html).toContain("tool-item");
    expect(html).not.toContain("No output captured.");
  });

  it("folds a run of tools into a transcript-style group", () => {
    const grouped = { ...byId("files"), tools: [read("r1", false), read("r2", false), read("r3", false)] };
    const html = render(<SubagentDetail run={grouped} now={NOW} workers={[]} onBack={() => {}} />);
    expect(text(html)).toContain("Read 3 files");
    expect(html.match(/class="tool-group"/g)).toHaveLength(1);
    expect(html).not.toContain("tool-item standalone");
  });
});
