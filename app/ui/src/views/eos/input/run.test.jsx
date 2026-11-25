import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { _resetHomeDraft, setHomeDraft, setHomePick } from "../../../state/eos/homeDraftStore.js";
import { _resetHomeRuns, addHomeRuns, addOnce, dismissOnce, markOnceKept, STOP_FOR_MS, useHomeRuns, useOnces } from "../../../state/eos/homeRunsStore.js";
import { _resetRoutines, keepRoutine, refreshRoutines, routineRow } from "../../../state/eos/routinesStore.js";
import { _resetRuns, loadRun, startOnce } from "../../../state/eos/runsStore.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import routines from "../gallery/sample/routines.json";
import runDetail from "../gallery/sample/run-detail.json";
import { menuRows } from "./CandidateList.jsx";
import { HomeInput } from "./HomeInput.jsx";
import { sheetInput } from "./InlineOptions.jsx";
import { lineEnded, lineTone, liveWords, LiveRunLines } from "./LiveRunLines.jsx";
import { onceStatus, OnceResults } from "./OnceResult.jsx";
import { homeForm, slotHint, tokenLine, usualLine, withText } from "./runInput.js";

const PR = { ...routines[0], takes: { ...routines[0].takes, itemPatterns: ["https://github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)", "(?:^|\\s)#(\\d+)\\b"] } };
const NOW = new Date(2026, 10, 23, 10, 0).getTime();
const formFor = (text, patch = {}) => ({ ...withText(PR, homeForm(PR, "", NOW), text), ...patch });

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

function recording(reads, answers = {}) {
  const sent = [];
  const fixture = fixtureTransport(reads);
  return {
    sent,
    transport: {
      ...fixture,
      send: async (method, path, body) => {
        sent.push({ method, path, body });
        return answers[path] ?? fixture.send(method, path, body);
      },
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetHomeDraft();
  _resetHomeRuns();
  _resetRoutines();
  _resetRuns();
});
afterEach(() => setEosTransport(null));

describe("the routine token's line", () => {
  it("names the run Enter starts, in the routine's words", () => {
    expect(tokenLine(PR, formFor(""), { now: NOW })).toEqual({ text: "Run PR Review on the latest pull request, draft for you", enter: true });
    expect(tokenLine(PR, formFor("#470", { options: { depth: "deep" }, result: "showOnly" }), { now: NOW }).text).toBe("Run PR Review on #470, deep, shown to you only");
    expect(tokenLine(PR, formFor("", { at: new Date(2026, 10, 24, 9, 0).getTime() }), { now: NOW }).text).toBe("Run PR Review on the latest pull request, draft for you, tomorrow 09:00");
  });

  it("turns Enter off for text that is not an item it takes", () => {
    expect(tokenLine(PR, formFor("shop carousel"), { now: NOW })).toEqual({ text: "Not a pull request. Number, link, or empty for the latest", enter: false });
  });

  it("says how many items, and the cost of all of them when paid by the run", () => {
    const items = [1, 2, 3].map((n) => ({ kind: "github.pull_request", key: `k${n}`, title: `#${n}` }));
    const routine = { ...PR, usual: { usd: 0.4, ms: 180000 } };
    expect(tokenLine(routine, formFor("", { items }), { now: NOW, plan: false }).text).toBe("Run PR Review on three pull requests, draft for you, about $1.20");
    expect(tokenLine(routine, formFor("", { items }), { now: NOW }).text).toBe("Run PR Review on three pull requests, draft for you");
    expect(usualLine(routine, false)).toBe("Usually three minutes and about $0.40 a run.");
  });

  it("takes a note where the routine takes no item", () => {
    const paper = { ...PR, name: "Paper", takes: { kind: "none" } };
    expect(withText(paper, homeForm(paper), "short today").note).toBe("short today");
    expect(slotHint(paper.takes)).toBe("A note for this run, or empty");
    expect(tokenLine(paper, withText(paper, homeForm(paper), "x")).text).toBe("Run Paper, draft for you");
  });

  it("opens More with the form as it is", () => {
    expect(sheetInput(PR, formFor("#470", { options: { depth: "deep" } }))).toMatchObject({ item: { text: "#470" }, options: { depth: "deep" } });
  });

  it("lists the routines a / query names", () => {
    expect(menuRows(routines, "/mail").map((r) => r.name)).toEqual(["Mail Triage"]);
    expect(menuRows(routines, "/")).toHaveLength(routines.length);
  });
});

describe("the Home input with a token", () => {
  it("draws the token, its item slot, its options and the run line", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: [PR] }));
    await refreshRoutines();
    setHomePick(PR.id);
    setHomeDraft("#470");
    const html = renderToStaticMarkup(<HomeInput />);
    expect(html).toContain('aria-label="Remove PR Review"');
    expect(html).toContain('aria-label="Which pull request"');
    expect(html).toContain('placeholder="Number, link, or empty for the latest"');
    expect(html).toContain("Show me only");
    expect(html).toContain('aria-label="Run"');
    expect(html).not.toContain('aria-label="Attach"');
  });
});

describe("live lines", () => {
  it("say what the run works on, then how it ended", () => {
    const working = { ...runDetail, run: { ...runDetail.run, state: "running", headline: undefined } };
    expect(liveWords("PR Review", null, null)).toBe("PR Review is starting.");
    expect(liveWords("PR Review", working, "The reader is on nine files.")).toBe("PR Review on #470. The reader is on nine files.");
    const waiting = { ...runDetail, run: { ...runDetail.run, state: "waiting_for_user", needsUser: true } };
    expect(liveWords("PR Review", waiting, null)).toBe("Done. A draft is in Needs you");
    expect(lineEnded(waiting.run)).toBe(true);
    expect(liveWords("PR Review", { ...runDetail, run: { ...runDetail.run, state: "failed", reason: "timeout" } }, null)).toMatch(/^PR Review failed\./);
    expect([null, { state: "queued" }, { state: "running" }, waiting.run, { state: "done" }, { state: "failed" }, { state: "cancelled" }].map(lineTone))
      .toEqual(["queued", "queued", "working", "you", "ok", "err", "ended"]);
  });

  it("show three at most and fold the rest; a drop may be stopped for five seconds", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.run(runDetail.run.id)]: runDetail }));
    addHomeRuns([1, 2, 3, 4, 5].map((n) => ({ id: `rn-${n}`, routineId: PR.id })), { now: 1000 });
    addHomeRuns([{ id: runDetail.run.id, routineId: PR.id }], { now: 2000, stoppable: true });
    let lines;
    const Probe = () => { lines = useHomeRuns(); return null; };
    renderToStaticMarkup(<Probe />);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({ runId: runDetail.run.id, stopUntil: 2000 + STOP_FOR_MS });
    await loadRun(runDetail.run.id);
    const html = renderToStaticMarkup(<LiveRunLines byId={new Map([[PR.id, PR]])} />);
    expect(html).toContain("+3 more running");
    expect(html).toContain("Done. Two findings, one of them blocking.");
  });
});

describe("doing it once from Home", () => {
  it("posts the sentence once and reads the answer", async () => {
    const started = { routineId: "rt-once", name: "Summarise the README", run: { id: "rn-once", routineId: "rt-once", state: "queued" } };
    const rec = recording({}, { [ROUTES.runsOnce]: { ok: true, status: 201, body: started } });
    setEosTransport(rec.transport);
    expect(await startOnce({ text: "summarise this README", attachments: [], result: "usual", door: "home" })).toEqual({ started: { routineId: "rt-once", name: "Summarise the README", runId: "rn-once" } });
    expect(rec.sent[0]).toMatchObject({ method: "POST", path: ROUTES.runsOnce, body: { text: "summarise this README", door: "home" } });
    setEosTransport(fixtureTransport({}));
    expect(await startOnce({ text: "x", attachments: [], result: "usual", door: "home" })).toEqual({ error: "sample data" });
  });

  it("keeps a one-off as a routine", async () => {
    const row = { ...PR, id: "rt-once", name: "Summarise", kind: "standing" };
    const rec = recording({ [ROUTES.routines]: [PR] }, { [ROUTES.routineKeep("rt-once")]: { ok: true, status: 200, body: row } });
    setEosTransport(rec.transport);
    await refreshRoutines();
    expect(await keepRoutine("rt-once")).toBe(true);
    expect(routineRow("rt-once")?.name).toBe("Summarise");
  });

  it("shows each result card until dismissed, with Keep as a routine", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.run("rn-once")]: { ...runDetail, run: { ...runDetail.run, id: "rn-once", state: "running", headline: undefined } } }));
    addOnce({ routineId: "rt-once", name: "Summarise the README", runId: "rn-once" });
    await loadRun("rn-once");
    let html = renderToStaticMarkup(<OnceResults />);
    expect(html).toContain("Summarise the README");
    expect(html).toContain("Working on it.");
    expect(html).toContain("Keep as a routine");
    expect(html).toContain("Dismiss");
    markOnceKept("rn-once");
    html = renderToStaticMarkup(<OnceResults />);
    expect(html).toContain("Kept. Open the routine");
    dismissOnce("rn-once");
    let onces;
    const Probe = () => { onces = useOnces(); return null; };
    renderToStaticMarkup(<Probe />);
    expect(onces).toEqual([]);
    expect(onceStatus(null)).toBe("Starting.");
  });
});
