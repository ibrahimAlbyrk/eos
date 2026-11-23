import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { endBoot, receiveBoot } from "../../../api/boot.js";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { _resetHome, refreshHome, RUNS_PATH, summaryPath } from "../../../state/eos/homeStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetNotes, refreshMemorySummary } from "../../../state/eos/notesStore.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { SAMPLE_READS } from "../gallery/EosGallery.jsx";
import { homeNext, homeRuns } from "../gallery/sample/home.js";
import inbox from "../gallery/sample/inbox.json";
import { HomeScreen } from "./HomeScreen.jsx";

const NOW = new Date(2026, 10, 17, 9, 12).getTime();

function reads(patch = {}) {
  return { ...SAMPLE_READS, [RUNS_PATH]: { runs: homeRuns(NOW) }, [ROUTES.signalsRoutines]: homeNext(NOW), ...patch };
}

async function loaded(transport) {
  setEosTransport(transport);
  await Promise.all([refreshHome(), refreshInbox(), refreshRoutines(), refreshMemorySummary()]);
}

const draw = () => renderToStaticMarkup(<HomeScreen clock={() => NOW} />);

beforeEach(() => {
  _resetHome();
  _resetInbox();
  _resetRoutines();
  _resetNotes();
});
afterEach(() => setEosTransport(null));

describe("Eos › Home", () => {
  it("typical: the day's arc, the greeting with its counts, chips, three cards, the away list and the learned line", async () => {
    await loaded(fixtureTransport(reads()));
    const html = draw();
    expect(html).toContain('role="img" aria-label="Today so far: six runs, two of them waiting for you. Two more are scheduled."');
    expect(html).toContain('<h1 class="eos-greeting">Good morning, Ada.<br/><span class="eos-greeting__dim">Eos handled 31 things overnight.</span> <span class="eos-greeting__need">Five need you.</span></h1>');
    expect(html).toContain("Review my pull requests");
    expect(html.match(/<article class="eos-home-card">/g)).toHaveLength(3);
    expect(html).toContain("All 5 in Needs you");
    expect(html).toContain("While you were away");
    expect([...html.matchAll(/class="eos-away__routine">([^<]+)</g)].map((m) => m[1])).toEqual(["Build Watch", "Morning Paper", "PR Review", "Mail Triage"]);
    expect(html).toContain("Eos learned three things this week.");
    expect(html).not.toContain("autofocus");
  });

  it("empty: nothing ran and nothing waits, so only the arc, the greeting and the chips show", async () => {
    await loaded(fixtureTransport(reads({
      [RUNS_PATH]: { runs: [] },
      [ROUTES.signalsRoutines]: [],
      [ROUTES.inbox]: { ...inbox, items: [], counts: { open: 0, later: 0, byKind: {}, byRoutine: {} } },
      [ROUTES.signalsSummary]: { since: 0, counts: { handled: 0 }, byRoutine: {} },
      [ROUTES.memorySummary]: { ...SAMPLE_READS[ROUTES.memorySummary], weekly: 0 },
    })));
    const html = draw();
    expect(html).toContain("Nothing has run today.");
    expect(html).toContain("Nothing new overnight.");
    expect(html).not.toContain("need you");
    expect(html).not.toContain("Needs you</h2>");
    expect(html).not.toContain("While you were away");
    expect(html).not.toContain("this week");
  });

  it("first run: no routine yet, so the first-run line and the chips, nothing else", async () => {
    await loaded(fixtureTransport(reads({ [ROUTES.routines]: [], [RUNS_PATH]: { runs: [] } })));
    const html = draw();
    expect(html).toContain("Tell Eos what to take care of. It shows you a trial before anything runs.");
    expect(html).toContain("Set up a new project");
    expect(html).not.toContain("eos-home-card");
    expect(html).not.toContain("While you were away");
    expect(html).not.toContain("Eos learned");
  });

  it("many: two hundred runs still make at most 96 dots, and the cards stop at three", async () => {
    const start = new Date(NOW).setHours(0, 0, 0, 0);
    const runs = Array.from({ length: 200 }, (_, i) => ({ ...homeRuns(NOW)[2], id: `rn-m${i}`, createdAt: start + i * 2 * 60 * 1000, startedAt: start + i * 2 * 60 * 1000 }));
    const items = Array.from({ length: 12 }, (_, i) => ({ ...inbox.items[3], id: `inb-${i}`, title: `Draft ${i}` }));
    await loaded(fixtureTransport(reads({ [RUNS_PATH]: { runs }, [ROUTES.inbox]: { ...inbox, items } })));
    const html = draw();
    expect((html.match(/class="eos-horizon__dot /g) ?? []).length).toBeLessThanOrEqual(96);
    expect(html.match(/<article class="eos-home-card">/g)).toHaveLength(3);
    expect(html).toContain("12 need you.");
    expect(html).toContain("All 12 in Needs you");
  });

  it("loading: skeleton blocks, never a spinner", async () => {
    setEosTransport({ get: () => new Promise(() => {}), send: () => new Promise(() => {}) });
    const html = draw();
    expect(html).toContain('class="eos-skeleton" aria-busy="true"');
    expect(html).not.toContain("spin");
  });

  it("error: the runs could not be read, with Try again", async () => {
    const { [RUNS_PATH]: _, ...rest } = reads();
    await loaded(fixtureTransport(rest));
    expect(draw()).toContain("Couldn&#x27;t load runs. <button");
  });

  it("offline: what was read stays, and Home says it is reconnecting", async () => {
    await loaded(fixtureTransport(reads()));
    setEosTransport({ get: () => Promise.reject(new Error("down")), send: () => Promise.reject(new Error("down")) });
    await refreshHome();
    const html = draw();
    expect(html).toContain('<p class="eos-home__offline" role="status">Reconnecting…</p>');
    expect(html).toContain("Eos handled 31 things overnight.");
  });
});

describe("Home's first paint", () => {
  afterEach(() => {
    endBoot();
    vi.unstubAllGlobals();
  });

  it("draws from the boot snapshot's parts, keyed by the paths Home asks, without a request of its own", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no request expected")));
    vi.stubGlobal("fetch", fetchMock);
    const all = reads();
    const paths = [ROUTES.profile, ROUTES.routines, ROUTES.inbox, RUNS_PATH, ROUTES.signalsRoutines, ROUTES.memorySummary, summaryPath(null)];
    await receiveBoot(Promise.resolve({ hello: {}, parts: Object.fromEntries(paths.map((p) => [p, { status: 200, body: all[p] }])) }));
    setEosTransport(null);
    await Promise.all([refreshHome(), refreshInbox(), refreshRoutines(), refreshMemorySummary()]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(draw()).toContain("Good morning, Ada.");
  });

  it("asks the handled count since the last visit, as index.html names it", () => {
    expect(summaryPath(null)).toBe("/api/signals/summary");
    expect(summaryPath(1763452800000)).toBe("/api/signals/summary?since=1763452800000");
  });
});
