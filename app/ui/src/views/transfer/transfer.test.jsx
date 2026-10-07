import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../state/ui.jsx";
import { PaneScopeContext } from "../../state/paneScope.js";
import { applyTransferChange, isActive, undecided, useTransfers } from "../../state/transfersStore.js";
import { TransferCard } from "./TransferCard.jsx";
import { RecentTransfers } from "./RecentTransfers.jsx";
import { Destination } from "./Destination.jsx";
import { etaLabel, namesOf, percentOf, rateLabel, tildify } from "./text.js";

vi.mock("../../api/client.js", () => ({ api: { listTransfers: vi.fn(async () => []) } }));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const HOST = "b".repeat(64);
const label = (ref) => (ref === "local" ? "This Mac" : "Mac Studio");
const base = {
  id: "tr-00000001", from: HOST, to: "local", origin: { kind: "user" }, sources: ["/Users/me/neon/builds/web.zip"],
  destDir: "/Users/me/Downloads/Eos", destReason: "default", status: "copying", error: null,
  roots: [{ name: "web.zip", type: "file", size: 41_200_000, mtimeMs: 2 }], fileCount: 1,
  totalBytes: 41_200_000, doneBytes: 25_600_000, rate: 18_000_000, route: "direct",
  conflicts: [], decisions: {}, placed: [], createdAt: 1, startedAt: 1, finishedAt: null,
};
const t = (over) => ({ ...base, ...over });

const render = (node) => renderToStaticMarkup(
  <UiProvider><PaneScopeContext.Provider value="leaf-a">{node}</PaneScopeContext.Provider></UiProvider>,
);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("transfer words", () => {
  it("names what's moving, how far and how fast", () => {
    expect(namesOf(base)).toBe("web.zip");
    expect(namesOf(t({ roots: [{ name: "a" }, { name: "b" }] }))).toBe("a and b");
    expect(namesOf(t({ roots: [{ name: "a" }, { name: "b" }, { name: "c" }] }))).toBe("3 items");
    expect(percentOf(base)).toBe(62);
    expect(rateLabel(18_000_000)).toBe("17 MB/s");
    expect(etaLabel(base)).toBe("1 s left");
    expect(tildify("/Users/me/Projects/neon")).toBe("~/Projects/neon");
  });
});

describe("transfersStore", () => {
  beforeEach(() => applyTransferChange({ removed: ["tr-00000001", "tr-00000002"] }));

  it("takes each change whole, newest first, and drops cleared ones", () => {
    let seen = null;
    function Probe() { seen = useTransfers(); return null; }
    applyTransferChange({ transfer: t({ id: "tr-00000001", createdAt: 1 }) });
    applyTransferChange({ transfer: t({ id: "tr-00000002", createdAt: 2 }) });
    applyTransferChange({ transfer: t({ id: "tr-00000001", createdAt: 1, status: "done" }) });
    renderToStaticMarkup(<Probe />);
    expect(seen.map((x) => [x.id, x.status])).toEqual([["tr-00000002", "copying"], ["tr-00000001", "done"]]);
    applyTransferChange({ removed: ["tr-00000001"] });
    renderToStaticMarkup(<Probe />);
    expect(seen.map((x) => x.id)).toEqual(["tr-00000002"]);
  });

  it("knows what's still moving and what still needs an answer", () => {
    expect(isActive(t({ status: "conflict" }))).toBe(true);
    expect(isActive(t({ status: "paused" }))).toBe(false);
    const c = { name: "web.zip", existing: { type: "file", size: 1, mtimeMs: 1 }, incoming: { type: "file", size: 2, mtimeMs: 2 } };
    expect(undecided(t({ conflicts: [c] }))).toHaveLength(1);
    expect(undecided(t({ conflicts: [c], decisions: { "web.zip": "keep" } }))).toHaveLength(0);
  });
});

describe("TransferCard", () => {
  it("in flight: what, from where, how fast, and pause / cancel", () => {
    const html = render(<TransferCard t={base} label={label} onDismiss={() => {}} />);
    expect(text(html)).toContain("Copying web.zip");
    expect(text(html)).toContain("from Mac Studio");
    expect(text(html)).toContain("17 MB/s · direct · 1 s left");
    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-valuenow="62"');
  });

  it("already there: both sides side by side, and the three answers", () => {
    const c = { name: "web.zip", existing: { type: "file", size: 40_900_000, mtimeMs: Date.now() - 2 * 86_400_000 }, incoming: { type: "file", size: 41_200_000, mtimeMs: Date.now() - 12 * 60_000 } };
    const html = text(render(<TransferCard t={t({ status: "conflict", conflicts: [c] })} label={label} onDismiss={() => {}} />));
    expect(html).toContain("web.zip is already in Eos");
    expect(html).toContain("Replaced files go to the Trash.");
    expect(html).toContain("On This Mac 39 MB · 2d ago");
    expect(html).toContain("Incoming · newer 39 MB · 12m ago");
    for (const b of ["Skip", "Keep both", "Replace"]) expect(html).toContain(b);
  });

  it("an agent's send says who sent it", () => {
    const html = text(render(<TransferCard t={t({ from: "local", to: HOST, origin: { kind: "agent", agentId: "w1", agentName: "Focus" } })} label={label} onDismiss={() => {}} />));
    expect(html).toContain("Focus · to Mac Studio");
  });

  it("stalled ones offer Resume; a failed one says why", () => {
    expect(text(render(<TransferCard t={t({ status: "interrupted" })} label={label} onDismiss={() => {}} />))).toContain("Mac Studio went out of reach");
    const failed = text(render(<TransferCard t={t({ status: "failed", error: { code: "no-space", message: "needs 41 MB but only 3 MB is free" } })} label={label} onDismiss={() => {}} />));
    expect(failed).toContain("Couldn’t copy web.zip");
    expect(failed).toContain("needs 41 MB but only 3 MB is free");
    expect(failed).toContain("Try again");
  });

  it("done: where it landed", () => {
    const html = text(render(<TransferCard t={t({ status: "done", placed: [{ name: "web.zip", path: "/Users/me/Downloads/Eos/web.zip" }] })} label={label} onDismiss={() => {}} />));
    expect(html).toContain("web.zip copied");
    expect(html).toContain("~/Downloads/Eos");
  });
});

describe("the rest of the tab", () => {
  it("keeps finished transfers behind one quiet row", () => {
    const html = text(render(<RecentTransfers items={[t({ status: "done" }), t({ id: "tr-00000002", status: "failed" })]} label={label} onClear={() => {}} />));
    expect(html).toBe("Recent 2");
  });

  it("says why a folder was picked only when the project matched", () => {
    expect(text(render(<Destination dest={{ destDir: "/Users/me/neon/builds", reason: "project" }} toLabel="This Mac" onChange={() => {}} />)))
      .toContain("Same project on This Mac — matched by its git remote.");
    expect(text(render(<Destination dest={{ destDir: "/Users/me/Downloads/Eos", reason: "default" }} toLabel="This Mac" onChange={() => {}} />)))
      .not.toContain("matched");
  });
});
