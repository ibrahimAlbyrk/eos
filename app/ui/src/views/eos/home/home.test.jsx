import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { endBoot, receiveBoot } from "../../../api/boot.js";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { _resetHome, LAST_SEEN_KEY, openHomeVisit, refreshHome, RUNS_PATH, summaryPath } from "../../../state/eos/homeStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetNotes, refreshMemorySummary } from "../../../state/eos/notesStore.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { SAMPLE_READS } from "../gallery/EosGallery.jsx";
import { homeNext, homeRuns } from "../gallery/sample/home.js";
import inbox from "../gallery/sample/inbox.json";
import { HomeScreen } from "./HomeScreen.jsx";
import { ARC_R, ARC_TOP, arcRadius, skyHeight, skyMask } from "./Horizon.jsx";
import { _resetPins, refreshPins } from "../../../state/eos/pinsStore.js";
import { tileAction, tileLocation, tileStatus, tileWhen } from "./PinnedTiles.jsx";

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
  _resetPins();
});
afterEach(() => setEosTransport(null));

describe("Eos › Home", () => {
  it("pinned: the tiles after Needs you, with their count of three, their headline and their unpin", async () => {
    await loaded(fixtureTransport(reads()));
    await refreshPins();
    const html = draw();
    expect(html).toContain('<h2 id="eos-home-pins" class="eos-label">Pinned</h2><span class="eos-pins__count">2 of 3</span>');
    expect(html).toContain('<p class="eos-tile__headline">Nothing broke overnight</p>');
    expect(html).toContain('aria-label="Unpin Morning Paper"');
    expect(html).toContain('class="eos-tile__open">Read issue 3<svg');
    expect(html).toContain("One more place</p>");
    expect(html.indexOf("eos-home-needs")).toBeLessThan(html.indexOf("eos-home-pins"));
    const now = new Date(2026, 10, 18, 12, 0).getTime();
    expect(tileWhen(new Date(2026, 10, 18, 8, 0).getTime(), now)).toBe("08:00");
    expect(tileWhen(new Date(2026, 10, 17, 20, 0).getTime(), now)).toBe("Yesterday");
    expect(tileWhen(new Date(2026, 10, 12, 8, 0).getTime(), now)).toBe("Nov 12");
    expect(tileWhen(undefined, now)).toBe(null);
    expect(tileLocation({ level: "page", surfaceId: "sf-1" })).toBe("eos:/surfaces/sf-1");
    expect(tileLocation({ level: "view", routineId: "rt-1" })).toBe("eos:/routines/rt-1");
    expect(tileAction({ level: "page" })).toBe("Read the issue");
    expect(tileAction({ level: "page", action: "Read all 3" })).toBe("Read all 3");
    expect(tileStatus({ state: "active", live: 1, last: { headline: "Two reviews" } })).toBe("Running now");
    expect(tileStatus({ state: "active", live: 0, last: { headline: "Two reviews" } })).toBe("Two reviews");
    expect(tileStatus({ state: "paused", live: 0, last: null })).toBe("Paused");
    expect(tileStatus(undefined)).toBe("Nothing yet");
  });


  it("typical: the day's arc, the greeting with its counts, chips, three cards, the away list and the learned line", async () => {
    await loaded(fixtureTransport(reads()));
    const html = draw();
    expect(html).toContain('role="img" aria-label="Today so far: six runs, two of them waiting for you. One more is scheduled."');
    expect(html).toContain('<h1 class="eos-greeting">Good morning, Ibrahim.<br/><span class="eos-greeting__dim">Eos handled 31 things overnight.</span> <span class="eos-greeting__need">Five need you.</span></h1>');
    expect(html).toContain("Review my pull requests");
    expect(html.match(/<article class="eos-home-card">/g)).toHaveLength(3);
    expect(html).toContain('class="eos-home-card__glyph"><path');
    expect(html).toContain("All 5 in Needs you");
    expect(html).toContain("While you were away");
    expect([...html.matchAll(/class="eos-away__routine">([^<]+)</g)].map((m) => m[1])).toEqual(["Build Watch", "Morning Paper", "PR Review", "Mail Triage"]);
    expect(html).toContain("Eos learned three things this week.");
    expect(html).not.toContain("autofocus");
  });

  it("empty: nothing ran, waits or is scheduled, so the arc, the greeting, the chips and Coming up saying so", async () => {
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
    expect(html).not.toContain("Earlier today");
    expect(html).toContain('<h2 id="eos-home-next" class="eos-label">Coming up</h2><p class="eos-home-quiet">Nothing is scheduled to run.</p>');
    expect(html).not.toContain("this week");
  });

  it("coming up: the routines' next runs, soonest first, each opening its routine", async () => {
    await loaded(fixtureTransport(reads()));
    const html = draw();
    expect([...html.matchAll(/class="eos-next__name">([^<]+)</g)].map((m) => m[1])).toEqual(["Build Watch", "PR Review", "Morning Paper"]);
    expect(html).toContain('<span class="eos-next__when">In 18 min</span><span class="eos-next__clock">09:30</span>');
    expect(html.indexOf("eos-home-next")).toBeLessThan(html.indexOf("eos-home-away"));
  });

  it("earlier today: with nothing new since the last visit, today's ended runs under their own label", async () => {
    globalThis.localStorage = { getItem: () => String(NOW - 60 * 1000), setItem() {}, removeItem() {} };
    try {
      openHomeVisit();
      await loaded(fixtureTransport(reads()));
      const html = draw();
      expect(html).not.toContain("While you were away");
      expect(html).toContain('class="eos-label">Earlier today</h2>');
      expect([...html.matchAll(/class="eos-away__routine">([^<]+)</g)].map((m) => m[1])).toEqual(["Build Watch", "Morning Paper", "PR Review", "Mail Triage"]);
    } finally {
      delete globalThis.localStorage;
    }
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
    expect(html).toContain('class="eos-skeleton eos-skeleton--rows" aria-busy="true"');
    expect(html).not.toContain("spin");
  });

  it("error: the runs could not be read, with Try again", async () => {
    const { [RUNS_PATH]: _, ...rest } = reads();
    await loaded(fixtureTransport(rest));
    const html = draw();
    expect(html).toContain('<div class="eos-band eos-band--err" role="alert"><span class="eos-band__text">Couldn&#x27;t load runs, so what is coming up and what ran today are missing here.</span>');
    expect(html).toContain('<button type="button" class="eos-btn">Try again</button>');
  });

  it("cannot read: the greeting claims nothing about what was handled", async () => {
    await loaded({ get: async () => ({ ok: false, status: 500, body: {} }), send: async () => ({ ok: false, status: 500, body: {} }) });
    const html = draw();
    expect(html).toContain("Good morning");
    expect(html).not.toContain("Nothing new");
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

describe("the visit Home counts from", () => {
  afterEach(() => { delete globalThis.localStorage; });

  it("is the mark found when Home opened, for the greeting and every later read, until Home opens again", async () => {
    const data = new Map();
    globalThis.localStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
    const before = NOW - 10 * 3600 * 1000;
    data.set(LAST_SEEN_KEY, String(before));
    const asked = [];
    const fixtures = fixtureTransport(reads({
      [summaryPath(before)]: { since: before, counts: { handled: 12 }, byRoutine: {} },
      [summaryPath(NOW)]: { since: NOW, counts: { handled: 0 }, byRoutine: {} },
    }));
    setEosTransport({ ...fixtures, get: (path) => { asked.push(path); return fixtures.get(path); } });
    await Promise.all([refreshInbox(), refreshRoutines(), refreshMemorySummary()]);
    openHomeVisit();
    await vi.waitFor(() => expect(draw()).toContain("Eos handled 12 things"));

    // Five seconds on Home marked this visit; a run changing reads again.
    data.set(LAST_SEEN_KEY, String(NOW));
    await refreshHome();
    expect(asked.filter((p) => p.startsWith(ROUTES.signalsSummary))).toEqual([summaryPath(before), summaryPath(before)]);
    expect(draw()).toContain("Eos handled 12 things");

    // Coming back to Home counts from the visit before.
    openHomeVisit();
    await vi.waitFor(() => expect(asked.filter((p) => p.startsWith(ROUTES.signalsSummary)).at(-1)).toBe(summaryPath(NOW)));
    await vi.waitFor(() => expect(draw()).not.toContain("handled 12"));
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
    expect(draw()).toContain("Good morning, Ibrahim.");
  });

  it("asks the handled count since the last visit, as index.html names it", () => {
    expect(summaryPath(null)).toBe("/api/signals/summary");
    expect(summaryPath(1763452800000)).toBe("/api/signals/summary?since=1763452800000");
  });
});

describe("the horizon's circle", () => {
  it("leaves the page at both sides at every width, at most 320 px below its crest", () => {
    for (let page = 724; page <= 2560; page += 4) {
      const r = arcRadius(page);
      expect(r).toBeGreaterThanOrEqual(page / 2);
      expect(r).toBeGreaterThanOrEqual(ARC_R);
      const drop = r - Math.sqrt(r * r - (page / 2) ** 2);
      expect(drop).toBeLessThanOrEqual(321);
      expect(skyHeight(page)).toBeGreaterThan(ARC_TOP + drop);
    }
  });

  it("keeps the 1800 px circle of the design in a page that size or smaller", () => {
    expect(arcRadius(1140)).toBe(ARC_R);
    expect(arcRadius(2000)).toBeGreaterThan(ARC_R);
  });

  it("fades only in the last few pixels at each edge", () => {
    expect(skyMask(2000)).toBe("linear-gradient(to right, transparent, #000 72px, #000 1928px, transparent)");
    expect(skyMask(980)).toBe("linear-gradient(to right, transparent, #000 59px, #000 921px, transparent)");
  });
});
