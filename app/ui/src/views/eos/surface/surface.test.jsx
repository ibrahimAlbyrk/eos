import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetPages, loadIssue, loadPage, loadVersion, pickIssue, sendFeedback } from "../../../state/eos/pageStore.js";
import { _resetPins, pin, refreshPins, replacePin, usePins } from "../../../state/eos/pinsStore.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { openableLink, pageMessage } from "./PageRenderer.jsx";
import { shareName } from "./ShareMenu.jsx";
import { partName, popoverPlace } from "./PointPopover.jsx";
import { failedFindings } from "./ReshapeBar.jsx";
import { applyDesignChange, arrange, reshape, stopReshape } from "../../../state/eos/pageStore.js";
import paper from "../gallery/sample/paper.json";
import routines from "../gallery/sample/routines.json";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../api/client.js", () => ({
  api: {
    setStreamFocus: async () => ({ ok: true, body: { live: [] } }),
    surfacePageUrl: (s, i, v) => `raw:/surfaces/${s}/issues/${i}/page.html${v == null ? "" : `?version=${v}`}`,
  },
}));

const SF = paper.surface.id;
const reads = {
  [ROUTES.routines]: routines,
  [ROUTES.surface(SF)]: paper.surface,
  [`${ROUTES.surfaceIssues(SF)}?limit=20`]: paper.issues,
  [ROUTES.surfaceVersion(SF, 2)]: paper.versionBodies["2"],
  [ROUTES.surfacePins]: paper.pins,
  [ROUTES.surfaceTiles]: paper.tiles,
  ...Object.fromEntries(Object.entries(paper.issueBodies).map(([id, one]) => [ROUTES.surfaceIssue(SF, id), one])),
};

function recording(sent = async () => ({ ok: true, status: 200, body: {} })) {
  const fixture = fixtureTransport(reads);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

async function screen(location, transport = fixtureTransport(reads)) {
  setEosTransport(transport);
  await refreshRoutines();
  await loadPage(SF);
  await refreshPins();
  const seq = new URLSearchParams(location.split("?")[1] ?? "").get("issue");
  const row = pickIssue(paper.issues.issues, seq == null ? undefined : Number(seq));
  await loadIssue(SF, row.id);
  await loadVersion(SF, 2);
  openLocation(location);
  return renderToStaticMarkup(<EosMain />);
}

function pinsNow() {
  let read;
  function Probe() {
    read = usePins();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

beforeEach(() => {
  _resetPages();
  _resetPins();
  _resetRoutines();
  _resetEosNav();
});
afterEach(() => setEosTransport(null));

describe("the page screen", () => {
  it("draws the newest issue in its sandboxed frame, with the issue line, pin, change and share", async () => {
    const html = await screen(`eos:/surfaces/${SF}`);
    expect(html).toContain('<h1 class="eos-title">Morning Paper</h1>');
    expect(html).toContain("Issue 3, printed");
    expect(html).toContain(`src="raw:/surfaces/${SF}/issues/si-7b3m1c000003/page.html"`);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('<section class="eos-frame eos-frame--page" aria-label="Made by Morning Paper">');
    expect(html).toContain('aria-pressed="true">Pinned to Home</button>');
    expect(html).toContain(">Change the page</button>");
    expect(html).toContain(">Mail preview</button>");
    expect(html).toContain(">Save as a file</button>");
    expect(html).toContain(">Earlier issues</button>");
    expect(html).toContain('aria-label="Tell Eos what to change about this page"');
    expect(html).toContain(">Good issue</button>");
    expect(html).toContain("A lead story with a desk column, then three sections.");
  });

  it("opens an earlier issue in the design it was made with, and offers today's design", async () => {
    const html = await screen(`eos:/surfaces/${SF}?issue=1`);
    expect(html).toContain(`src="raw:/surfaces/${SF}/issues/si-7b3m1c000001/page.html"`);
    expect(html).toContain("Issue 1, layout version 1");
    expect(html).toContain(">Show in today&#x27;s design</button>");
  });

  it("says when the page needs a new design", async () => {
    const tired = { ...reads, [ROUTES.surface(SF)]: { ...paper.surface, needsRedesign: { at: 1 } } };
    const html = await screen(`eos:/surfaces/${SF}`, fixtureTransport(tired));
    expect(html).toContain("The page needs a new design.");
  });

  it("says Good issue as the direct action surface.feedback on that issue", async () => {
    const transport = recording(async () => ({ ok: true, status: 200, body: { status: "done" } }));
    setEosTransport(transport);
    expect(await sendFeedback("si-7b3m1c000003", "good")).toEqual({ ok: true });
    const [method, path, body] = transport.send.mock.calls[0];
    expect([method, path]).toEqual(["POST", ROUTES.actionsRun]);
    expect(body).toMatchObject({ actionId: "surface.feedback", state: { issue: "si-7b3m1c000003", verdict: "good" } });
  });
});

describe("the page frame", () => {
  it("takes only the page's own kinds of message, and only from its frame", () => {
    const frame = {};
    expect(pageMessage({ source: frame, data: { type: "eos-page/act", button: "lead" } }, frame)).toEqual({ type: "eos-page/act", button: "lead" });
    expect(pageMessage({ source: {}, data: { type: "eos-page/act" } }, frame)).toBeNull();
    expect(pageMessage({ source: frame, data: { type: "eos-page/swap" } }, frame)).toBeNull();
    expect(pageMessage({ source: frame, data: "eos-page/act" }, frame)).toBeNull();
  });

  it("opens only http and https links", () => {
    expect(openableLink("https://example.com/a")).toBe("https://example.com/a");
    expect(openableLink("javascript:alert(1)")).toBeNull();
    expect(openableLink("eos-action:lead")).toBeNull();
    expect(openableLink("data:text/html,x")).toBeNull();
  });

  it("names the share file after the page and the issue", () => {
    expect(shareName("Morning Paper", 41)).toBe("morning-paper-41.html");
    expect(shareName("", null)).toBe("page.html");
  });
});

describe("pins", () => {
  it("a fourth pin is refused as full and the pins stay; replacing sends the three with the new one in place", async () => {
    const full = { surfaceIds: ["a", "b", "c"] };
    const transport = recording(async (method, path, body) => (body.surfaceIds.length > 3
      ? { ok: false, status: 409, body: { error: "Home holds 3 pins" } }
      : { ok: true, status: 200, body }));
    transport.get = vi.fn(async (path) => (path === ROUTES.surfacePins ? { ok: true, status: 200, body: full } : fixtureTransport(reads).get(path)));
    setEosTransport(transport);
    await refreshPins();
    expect(await pin("d")).toEqual({ ok: false, full: true });
    expect(pinsNow().ids).toEqual(["a", "b", "c"]);
    await replacePin("b", "d");
    expect(transport.send.mock.calls.at(-1)).toEqual(["PUT", ROUTES.surfacePins, { surfaceIds: ["a", "d", "c"] }]);
  });
});

describe("reshape mode", () => {
  const withCandidate = {
    ...reads,
    [ROUTES.surface(SF)]: { ...paper.surface, candidateVersion: 3 },
    [ROUTES.surfaceVersion(SF, 3)]: paper.versionBodies["3"],
  };

  it("asks to point at a part, draws the issue in point mode, and offers the whole-page line", async () => {
    const html = await screen(`eos:/surfaces/${SF}?mode=reshape`);
    expect(html).toContain('<span class="eos-chip">Changing the page</span>');
    expect(html).toContain(">Done</button>");
    expect(html).toContain("Click any part of the page, then say what should change there.");
    expect(html).toContain('aria-label="Or say what to change about the whole page"');
    expect(html).not.toContain(">Good issue</button>");
  });

  it("shows the new version with Before and After, Keep and Go back, drawn with the same issue", async () => {
    setEosTransport(fixtureTransport(withCandidate));
    await loadVersion(SF, 3);
    const html = await screen(`eos:/surfaces/${SF}?mode=reshape`, fixtureTransport(withCandidate));
    expect(html).toContain("Version 3. Live ops is gone; Tools has the room.");
    expect(html).toContain('role="radiogroup" aria-label="Compare versions"');
    expect(html).toContain(">Keep version 3</button>");
    expect(html).toContain(">Go back to 2</button>");
    expect(html).toContain(`src="raw:/surfaces/${SF}/issues/si-7b3m1c000003/page.html?version=3"`);
  });

  it("says Eos is at work after a reshape, and Cancel stops its run; a checked version ends it", async () => {
    const transport = recording(async (method, path) => (path === ROUTES.surfaceReshape(SF)
      ? { ok: true, status: 202, body: { runId: "rn-design" } }
      : { ok: true, status: 200, body: {} }));
    await screen(`eos:/surfaces/${SF}?mode=reshape`, transport);
    expect((await reshape(SF, { baseVersion: 2, instruction: "smaller headline", part: "lead", index: null })).ok).toBe(true);
    expect(transport.send.mock.calls[0]).toEqual(["POST", ROUTES.surfaceReshape(SF), { baseVersion: 2, instruction: "smaller headline", part: "lead" }]);
    expect(renderToStaticMarkup(<EosMain />)).toContain("Eos is changing the page…");
    expect(renderToStaticMarkup(<EosMain />)).toContain(">Cancel</button>");
    await stopReshape(SF);
    expect(transport.send.mock.calls.at(-1)).toEqual(["POST", ROUTES.runStop("rn-design"), {}]);
    await reshape(SF, { baseVersion: 2, instruction: "again" });
    applyDesignChange({ surfaceId: SF, version: 4, phase: "failed" });
    expect(renderToStaticMarkup(<EosMain />)).toContain("Version 4 did not pass its checks.");
  });

  it("sends Move up as arrange on the version on screen, with no agent", async () => {
    const transport = recording();
    setEosTransport(transport);
    await arrange(SF, { baseVersion: 3, part: "sections", op: "move_up" });
    expect(transport.send.mock.calls[0]).toEqual(["POST", ROUTES.surfaceArrange(SF), { baseVersion: 3, part: "sections", op: "move_up" }]);
  });

  it("names a part in words, keeps the popover inside the page, and lists what failed once", () => {
    expect(partName("live-ops")).toBe("Live ops");
    expect(popoverPlace({ x: 900, y: 100, width: 80, height: 40 }, 1000, 2000)).toEqual({ left: 672, top: 148 });
    expect(popoverPlace({ x: 10, y: 1900, width: 80, height: 60 }, 1000, 2000)).toEqual({ left: 10, top: 1742 });
    const finding = { check: "readable", part: "lead", detail: "text under 12 px" };
    const checks = { probe: [{ widths: [{ findings: [finding] }, { findings: [finding] }] }] };
    expect(failedFindings(checks)).toEqual(["lead: text under 12 px"]);
  });
});
