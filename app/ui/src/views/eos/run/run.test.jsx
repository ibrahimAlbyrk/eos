import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetRunLive, applyRunActivity, retain } from "../../../state/eos/runLiveStore.js";
import { _resetRuns, loadRun, loadRunResult, messageRun, pauseRun, resumeRun, stopRun } from "../../../state/eos/runsStore.js";
import { _resetRunSheet, registerHost, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { interruptionLines, stationStates } from "./RunStations.jsx";
import { TeamCard } from "./TeamCard.jsx";
import routines from "../gallery/sample/routines.json";
import runs from "../gallery/sample/runs.json";
import runResults from "../gallery/sample/run-results.json";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));

const DEV_RUN_TEXT = "This is a dev run: nothing starts or leaves the Mac.";
const byId = Object.fromEntries(runs.map((d) => [d.run.id.slice(3), d]));
const reads = {
  [ROUTES.routines]: routines,
  ...Object.fromEntries(runs.map((d) => [ROUTES.run(d.run.id), d])),
  ...Object.fromEntries(runResults.map((r) => [ROUTES.runResult(r.runId), r])),
};

function recording(sent = async () => ({ ok: true, status: 200, body: { ok: true } })) {
  const fixture = fixtureTransport(reads);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

async function screen(name, transport = fixtureTransport(reads)) {
  setEosTransport(transport);
  await refreshRoutines();
  const { run } = byId[name];
  await loadRun(run.id);
  if (run.state === "done") await loadRunResult(run.id);
  openLocation(`eos:/runs/${run.id}`);
  return renderToStaticMarkup(<EosMain />);
}

const states = (html) => [...html.matchAll(/<li class="eos-station eos-station--([a-z]+)"( aria-current="step")?>/g)].map((m) => m[1] + (m[2] ? "*" : ""));

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetRoutines();
  _resetRuns();
  _resetRunLive();
  _resetRunSheet();
  _resetEosNav();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("a run's stations", () => {
  const at = (state, station, reason) => stationStates({ state, station, reason }).map((s) => s.state);

  it("are none reached while queued or skipped, and all passed once done, ending lit where it reached you", () => {
    expect(at("queued")).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    expect(at("skipped", undefined, "superseded")).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    expect(at("done", "check")).toEqual(["done", "done", "done", "done", "arrived"]);
  });

  it("mark the station a live run is at", () => {
    expect(at("running", "brief")).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(at("running", "work")).toEqual(["done", "current", "todo", "todo", "todo"]);
    expect(at("checking", "check")).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(at("waiting_for_user", "gate")).toEqual(["done", "done", "done", "current", "todo"]);
    expect(at("delivering", "deliver")).toEqual(["done", "done", "done", "done", "current"]);
    expect(at("paused", "work", "day_cap")).toEqual(["done", "paused", "todo", "todo", "todo"]);
  });

  it("mark where a run failed or was stopped, whatever the reason", () => {
    for (const reason of ["no_result", "check_failed", "crashed", "budget_run", "interrupted", "reported"]) {
      expect(at("failed", "check", reason)).toEqual(["done", "done", "failed", "todo", "todo"]);
    }
    expect(at("failed", undefined, "invalid")).toEqual(["failed", "todo", "todo", "todo", "todo"]);
    expect(at("cancelled", "work", "user")).toEqual(["done", "stopped", "todo", "todo", "todo"]);
    expect(at("cancelled", undefined, "user")).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  });

  it("say each interruption and when the run carried on", () => {
    const t = (h, m) => new Date(2025, 10, 19, h, m).getTime();
    const lines = interruptionLines([
      { kind: "state", at: t(9, 0) },
      { kind: "interrupted", at: t(9, 5), data: { at: t(9, 2) } },
      { kind: "resumed", at: t(9, 10), data: { at: t(9, 10) } },
      { kind: "interrupted", at: t(9, 30), data: { at: t(9, 20) } },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Interrupted at .*09.02.*, resumed .*09.10/);
    expect(lines[1]).toMatch(/^Interrupted at .*09.20[^,]*$/);
  });
});

describe("the run view", () => {
  it("draws a queued run with its breadcrumb, state, origin as the lead's label, Stop and no team", async () => {
    const html = await screen("queued01");
    expect(html).toContain('<button type="button" class="eos-crumb">PR Review</button>');
    expect(html).toContain('<h1 class="eos-title">Run on #471</h1><span class="eos-status">Queued</span>');
    expect(html).toMatch(/<p class="eos-label">Started by hand · [^<]+<\/p>/);
    expect(html).toContain('<p class="eos-rlead__now">It starts as soon as Eos has room for it.</p>');
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--ghost eos-btn--stop">Stop</button>');
    expect(html).toContain("Waiting to start on #471 Pool the combo particles.");
    expect(states(html)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    expect(html).not.toContain('class="eos-team"');
  });

  it("draws a running team with its cards, its interruptions, the show-only line, Tell the team and the aside", async () => {
    const html = await screen("running01");
    expect(html).toMatch(/<span class="eos-status eos-status--active">Working, \d+ (min|h)/);
    expect(html).toContain("Shown to you only. Nothing will be sent from this run.");
    expect(states(html)).toEqual(["done", "current*", "todo", "todo", "todo"]);
    expect(html).toMatch(/Interrupted at [^<]*, resumed /);
    expect([...html.matchAll(/<span class="eos-team-card__name">([^<]*)</g)].map((m) => m[1])).toEqual(["Reader", "Unity specialist", "Allocation specialist"]);
    expect(html).toContain('<span class="eos-team-card__side">Opus 4.5 · working</span>');
    expect(html).toContain("<li>reading CarouselPager.cs</li>");
    expect(html).toContain('aria-label="Tell the team something"');
    expect(html).toContain("<dt>Item</dt><dd>#470 Rework shop carousel paging</dd>");
    expect(html).toContain("<dt>Depth</dt><dd>Deep</dd>");
    expect(html).toContain("<dt>Note</dt><dd>This time also look at the shaders.</dd>");
    expect(html).toContain("<dt>Result</dt><dd>Show me only</dd>");
    expect(html).toMatch(/<p class="eos-rlead__now">Two agents at work, [^<]+ in\.<\/p>/);
    expect(html).toContain('<span class="eos-station__word"><span class="eos-sr">, </span>now</span>');
    expect(html).toContain('<h2 class="eos-label">So far</h2>');
    expect(html).toContain('<dt>Time</dt><dd class="eos-run-cost__value">3 min</dd><dd class="eos-run-cost__usual">usually 5 min</dd>');
    expect(html).toContain('<dt>Cost</dt><dd class="eos-run-cost__value">$0.21</dd><dd class="eos-run-cost__usual">usually $0.55</dd>');
  });

  it("draws a run being checked and one that waits for the user, with the way to its item", async () => {
    const checking = await screen("checking01");
    expect(states(checking)).toEqual(["done", "done", "current*", "todo", "todo"]);
    expect(checking).toContain("Checking the result for #469 Fix the save slot.");
    expect(checking).toContain('<span class="eos-team-card__name">Checker</span>');

    const waiting = await screen("waiting01");
    expect(states(waiting)).toEqual(["done", "done", "done", "current*", "todo"]);
    expect(waiting).toContain('<span class="eos-status eos-status--active">Waiting for you</span>');
    expect(waiting).toContain('<p class="eos-run__sentence">The result waits for you in Needs you.</p>');
    expect(waiting).toContain('<p class="eos-rlead__now eos-rlead__now--active" role="status">Nothing goes out until you answer.</p>');
    expect(waiting).toContain('<button type="button" class="eos-btn eos-btn--primary">Open it in Needs you</button>');
    expect(waiting).toContain("waits for you</span>");
    expect(waiting).toContain('<h2 class="eos-label">The check</h2><span class="eos-section__aside">Passed</span>');
  });

  it("shows a finished show-only run's result, read-only, and a trial's under its own heading", async () => {
    const shown = await screen("shown01");
    expect(shown).toMatch(/<span class="eos-status eos-status--ok">Done in 4 min<\/span>/);
    expect(states(shown)).toEqual(["done", "done", "done", "done", "arrived"]);
    expect(shown).toContain('<h2 class="eos-label">What it made</h2>');
    expect(shown).toContain("<md>Clean change. One note about naming.</md>");
    expect(shown).not.toContain(">Stop</button>");
    expect(shown).not.toContain("Tell the team");
    expect(shown).toContain('<h2 class="eos-label">In all</h2>');

    const trial = await screen("trial01");
    expect(trial).toMatch(/<p class="eos-label">A trial · [^<]+<\/p>/);
    expect(trial).toContain("Shown to you only. Nothing will be sent from this run.");
    expect(trial).toContain('<h2 class="eos-label">Trial, nothing was sent</h2>');
    expect(trial).toContain("<md>Looks good. Should the haptics follow the system setting?</md>");
  });

  it("marks where a failed run failed, says why in its lead and which checks failed", async () => {
    const html = await screen("failed01");
    expect(html).toContain('<span class="eos-status eos-status--err">Failed</span>');
    expect(states(html)).toEqual(["done", "done", "failed*", "todo", "todo"]);
    expect(html).toContain('<p class="eos-rlead__now eos-rlead__now--err" role="status">Its result failed the check twice.</p>');
    expect(html).toContain('<span class="eos-section__aside eos-run-check__failed">1 of 2 failed</span>');
    expect(html).toContain('<li class="eos-fact eos-fact--err">Two findings name no line.<span class="eos-sr">, failed</span></li>');
    expect(html).toContain('<li class="eos-fact eos-fact--done">Nothing secret-like in the text.<span class="eos-sr">, passed</span></li>');
    expect(html).toContain("<li>Name the line of each finding.</li>");
    expect(html).not.toContain(">Stop</button>");
  });

  it("draws a stopped run and a paused one as such", async () => {
    const cancelled = await screen("cancelled01");
    expect(cancelled).toContain('<span class="eos-status">Stopped</span>');
    expect(cancelled).toContain("You stopped this run.");
    expect(states(cancelled)).toEqual(["done", "stopped*", "todo", "todo", "todo"]);

    const paused = await screen("paused01");
    expect(paused).toContain('<span class="eos-status eos-status--warn">Paused</span>');
    expect(paused).toContain("Paused. Today&#x27;s spending limit was reached.");
    expect(states(paused)).toEqual(["done", "paused*", "todo", "todo", "todo"]);
    expect(paused).toContain(">Stop</button>");
    expect(paused).toContain('<span class="eos-team-card__side">Sonnet 4.5 · resting</span>');
  });

  it("says when the run is gone or could not be read", async () => {
    setEosTransport(fixtureTransport({}));
    await loadRun("rn-gone");
    openLocation("eos:/runs/rn-gone");
    expect(renderToStaticMarkup(<EosMain />)).toContain("This run is no longer here.");

    setEosTransport({ get: async () => ({ ok: false, status: 500, body: {} }), send: vi.fn() });
    await loadRun("rn-broken");
    openLocation("eos:/runs/rn-broken");
    expect(renderToStaticMarkup(<EosMain />)).toContain("Couldn&#x27;t load this run.");
  });

  it("shows Run again only once a run sheet is hosted, and fills the sheet from the run's input", async () => {
    expect(await screen("failed01")).not.toContain(">Run again</button>");
    registerHost();
    const html = await screen("failed01");
    // Once, beside what went wrong: the header leaves it there.
    expect(html.match(/>Run again<\/button>/g)).toHaveLength(1);
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Run again</button>');

    let sheet;
    function Probe() {
      sheet = useRunSheet();
      return null;
    }
    const { open } = await import("../../../state/eos/runSheetStore.js");
    const { run, input } = byId.failed01;
    open({ routineId: run.routineId, anchor: null, input, againOf: run.id });
    renderToStaticMarkup(<Probe />);
    expect(sheet.request).toEqual({ routineId: run.routineId, anchor: null, input, againOf: run.id });
  });
});

describe("the run view's writes", () => {
  it("Stop says Stopping… until the core answers, then reads the run again", async () => {
    let answer;
    const transport = recording(() => new Promise((resolve) => { answer = resolve; }));
    await screen("running01", transport);
    const stopping = stopRun("rn-running01");
    expect(renderToStaticMarkup(<EosMain />)).toContain('disabled="">Stopping…</button>');
    expect(transport.send).toHaveBeenCalledWith("POST", ROUTES.runStop("rn-running01"), undefined);
    answer({ ok: true, status: 200, body: { ok: true } });
    await stopping;
    expect(transport.get).toHaveBeenLastCalledWith(ROUTES.run("rn-running01"));
    expect(renderToStaticMarkup(<EosMain />)).toContain(">Stop</button>");
  });

  it("Pause pauses a working run, and a run the user paused offers Resume", async () => {
    const transport = recording();
    let html = await screen("running01", transport);
    expect(html).toContain(">Pause</button>");
    expect(html).not.toContain(">Resume</button>");
    await pauseRun("rn-running01");
    expect(transport.send).toHaveBeenCalledWith("POST", ROUTES.runPause("rn-running01"), undefined);
    expect(transport.get).toHaveBeenLastCalledWith(ROUTES.run("rn-running01"));

    const paused = { ...byId.paused01, run: { ...byId.paused01.run, reason: "user" } };
    const read = fixtureTransport({ ...reads, [ROUTES.run(paused.run.id)]: paused });
    const resumed = { get: vi.fn(read.get), send: vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } })) };
    html = await screen("paused01", resumed);
    expect(html).toContain("Paused. You paused it.");
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Resume</button>');
    expect(html).not.toContain(">Pause</button>");
    await resumeRun(paused.run.id);
    expect(resumed.send).toHaveBeenCalledWith("POST", ROUTES.runResume(paused.run.id), undefined);
    expect(await screen("paused01")).not.toContain(">Resume</button>");
  });

  it("Tell the team sends the words to the run, and a dev run says so instead of failing", async () => {
    const transport = recording();
    await screen("running01", transport);
    expect(await messageRun("rn-running01", "Look at the shaders too")).toBe(true);
    expect(transport.send).toHaveBeenCalledWith("POST", ROUTES.runMessage("rn-running01"), { text: "Look at the shaders too" });

    await screen("running01", recording(async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: POST /api/runs/:id/message" } })));
    expect(await messageRun("rn-running01", "x")).toBe(false);
    expect(renderToStaticMarkup(<EosMain />)).toContain(DEV_RUN_TEXT);
  });
});

describe("a team card", () => {
  it("shows the agent's last three lines as they arrive, as plain text", async () => {
    const agent = byId.running01.agents[0];
    retain("rn-running01");
    for (const line of ["read <b>a</b>", "two", "three", "four"]) {
      applyRunActivity({ runId: "rn-running01", workerId: agent.workerId, agentKey: agent.agentKey, line, at: 1 });
    }
    setEosTransport(fixtureTransport(reads));
    await loadRun("rn-running01");
    openLocation("eos:/runs/rn-running01");
    const html = renderToStaticMarkup(<EosMain />);
    expect(html).toContain('<ul class="eos-team-card__lines" role="status"><li>two</li><li>three</li><li>four</li></ul>');

    const plain = renderToStaticMarkup(<TeamCard agent={agent} lines={["read <b>a</b>"]} />);
    expect(plain).toContain("<li>read &lt;b&gt;a&lt;/b&gt;</li>");
  });
});
