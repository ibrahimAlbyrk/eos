import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetBlueprints } from "../../../state/eos/blueprintStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { applyEosEvent } from "../../../state/eos/live.js";
import { _resetRoutines, loadRoutine, refreshRoutines } from "../../../state/eos/routinesStore.js";
import {
  _resetSignals, addSourcePush, loadSchedulePreview, loadSignals, loadTriggerStatus, loadWhichPreview, replaySignals, setSignalFilter,
} from "../../../state/eos/signalsStore.js";
import { notify } from "../../../lib/notify.js";
import { _resetCapabilities, refreshCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { EosMain } from "../EosMain.jsx";
import { localZone } from "../blueprint/slots/when.js";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { onLocalZone } from "./Triggers.jsx";
import { decisionLine, timeAt, zoneName } from "./words.js";
import routines from "../gallery/sample/routines.json";
import routineDetail from "../gallery/sample/routine-detail.json";
import routinePaused from "../gallery/sample/routine-paused.json";
import inbox from "../gallery/sample/inbox.json";
import triggerStatus from "../gallery/sample/trigger-status.json";
import signals from "../gallery/sample/signals.json";

// This Mac is on London time, so the Istanbul schedule is in another zone
// wherever the tests run.
vi.mock("../blueprint/slots/when.js", async (actual) => ({ ...(await actual()), localZone: () => "Europe/London" }));
vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));

const PR = routineDetail.routine.id;
const MAIL = routinePaused.routine.id;
const status = triggerStatus[PR];
const LIST = `${ROUTES.signals}?routine=${PR}`;
const reads = {
  [ROUTES.routines]: routines,
  [ROUTES.inbox]: inbox,
  [ROUTES.routine(PR)]: routineDetail,
  [ROUTES.routine(MAIL)]: routinePaused,
  [ROUTES.signalsRoutine(PR)]: status,
  [ROUTES.signalsRoutine(MAIL)]: triggerStatus[MAIL],
  [LIST]: signals,
};

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function recording(sent, paths = reads) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

async function page(location, transport = fixtureTransport(reads)) {
  setEosTransport(transport);
  await refreshRoutines();
  await refreshInbox();
  const id = location.split("/")[2].split("?")[0];
  await loadRoutine(id);
  await loadTriggerStatus(id);
  await loadSignals(id);
  openLocation(location);
  return renderToStaticMarkup(<EosMain />);
}

const draw = () => renderToStaticMarkup(<EosMain />);
const section = (html, label) => html.slice(html.indexOf(`aria-label="${label}"`));
const lines = (html, cls) => [...html.matchAll(new RegExp(`class="${cls}">([^<]*)<`, "g"))].map((m) => m[1].replaceAll("&#x27;", "'"));

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetCapabilities();
  _resetRoutines();
  _resetInbox();
  _resetSignals();
  _resetBlueprints();
  _resetEosNav();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("what starts a routine", () => {
  it("says each schedule with its next and last time, how late and how many missed, each source and the open batch", async () => {
    const html = section(await page(`eos:/routines/${PR}`), "What starts it");
    expect(html).toContain('<h2 class="eos-label">What starts it</h2>');
    expect(lines(html, "eos-trigger__name")).toEqual([
      expect.stringMatching(/^Runs on weekdays at 05:00/),
      "github.pulls",
      "3 items wait to run together",
    ]);
    expect(lines(html, "eos-trigger__facts")).toEqual([
      `Next ${timeAt(status.schedules[0].nextAt)} · last ${timeAt(status.schedules[0].lastAt)} · ran 2 h late · 2 missed while the Mac slept or Eos was closed, run as one`,
      expect.stringMatching(new RegExp(`^Last looked .* ago · next ${timeAt(status.sources[0].nextPollAt)}$`)),
      "14 items from while Eos was closed",
      `Until ${timeAt(status.batch.closesAt)}`,
    ]);
    expect(html).toContain('<span class="eos-trigger__state eos-trigger__state--ok">Working</span>');
  });

  it("hints at a schedule in another zone and moves it to this Mac's zone through the blueprint", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: { row: routineDetail.routine, versionId: "rv-new", warnings: [] } }));
    const html = await page(`eos:/routines/${PR}`, t);
    const here = zoneName(localZone());
    expect(html).toContain(`<span>05:00 Istanbul time; you are on ${here} time</span><button type="button" class="eos-btn">Use ${here} time</button>`);

    const moved = onLocalZone(routineDetail.head.blueprint, 1);
    expect(moved.when.on).toEqual([routineDetail.head.blueprint.when.on[0], { schedule: { daily: "05:00", days: "weekdays", zone: localZone() } }]);

    const same = { ...status, schedules: [{ ...status.schedules[0], zoneDiffers: false }] };
    _resetSignals();
    setEosTransport(fixtureTransport({ ...reads, [ROUTES.signalsRoutine(PR)]: same }));
    await loadTriggerStatus(PR);
    expect(draw()).not.toContain("time; you are on");
  });

  it("gives no zone hint when the schedule's zone is this Mac's own", async () => {
    const london = { ...status, schedules: [{ ...status.schedules[0], zone: "Europe/London" }] };
    expect(await page(`eos:/routines/${PR}`, fixtureTransport({ ...reads, [ROUTES.signalsRoutine(PR)]: london }))).not.toContain("time; you are on");
  });

  it("names a capability's source by the capability", async () => {
    const caps = [{ id: "github", name: "GitHub" }];
    const transport = fixtureTransport({ ...reads, [ROUTES.capabilities]: caps });
    setEosTransport(transport);
    await refreshCapabilities();
    const html = await page(`eos:/routines/${PR}`, transport);
    expect(html).toContain('<span class="eos-trigger__name">GitHub: pulls</span>');
  });

  it("says each source's state and why", async () => {
    const sources = [
      { sourceId: "a", kind: "capability", source: "github.pulls", state: "off" },
      { sourceId: "b", kind: "capability", source: "github.pulls", state: "needs-attention", errorKind: "unauthorized" },
      { sourceId: "c", kind: "capability", source: "github.pulls", state: "backing-off", errorKind: "rate-limited" },
      { sourceId: "d", kind: "folder", state: "backing-off", errorKind: "unreachable" },
      { sourceId: "e", kind: "capability", source: "github.pulls", state: "needs-attention", errorKind: "gone" },
      { sourceId: "f", kind: "git", state: "needs-attention", errorKind: "no-access" },
      { sourceId: "g", kind: "after", state: "stopped" },
      { sourceId: "h", kind: "folder", state: "needs-attention", errorKind: "missing" },
      { sourceId: "i", kind: "folder", state: "needs-attention", errorKind: "inside-data" },
      { sourceId: "j", kind: "folder", state: "needs-attention", errorKind: "too-many" },
      { sourceId: "k", kind: "folder", state: "needs-attention", errorKind: "too-many-folders" },
      { sourceId: "l", kind: "folder", state: "needs-attention", errorKind: "unreadable" },
    ];
    const html = await page(`eos:/routines/${PR}`, fixtureTransport({ ...reads, [ROUTES.signalsRoutine(PR)]: { ...status, schedules: [], batch: undefined, sources } }));
    expect(lines(html, "eos-trigger__name")).toEqual(["github.pulls", "github.pulls", "github.pulls", "A folder", "github.pulls", "A git repository", "Another routine's runs", "A folder", "A folder", "A folder", "A folder", "A folder"]);
    expect([...html.matchAll(/eos-trigger__state--(?:ok|warn)">([^<]*)</g)].map((m) => m[1])).toEqual([
      "Off: Polling is off in a development run",
      "Needs you: Sign in again",
      "Trying again later: Asked to slow down",
      "Trying again later: Could not reach it",
      "Needs you: What it watched is gone",
      "Needs you: The sign-in may not read it",
      "Stopped: Nothing reads it any more",
      "Needs you: Not found on this Mac",
      "Needs you: It is inside Eos&#x27;s own data folder, which Eos does not watch",
      "Needs you: It holds more than 5,000 entries",
      "Needs you: More than 20 folders are watched on this Mac",
      "Needs you: This Mac could not read it",
    ]);
  });

  it("adds a source's webhook, then says it is told at once; a refusal for admin rights is said plainly", async () => {
    const SRC = status.sources[0].sourceId;
    const button = '<button type="button" class="eos-btn">Hear about changes at once</button>';
    const t = recording(async () => ({ ok: false, status: 403, body: { error: "the service refused the webhook: it needs admin rights on the repository" } }));
    expect(await page(`eos:/routines/${PR}`, t)).toContain(button);
    expect(await addSourcePush(PR, SRC)).toBe(false);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.signalsSourcePush(SRC), {});
    expect(draw()).toContain('<span class="eos-trigger__refused" role="alert">Not added: a webhook needs admin rights on the repository. Eos keeps looking for changes on its own schedule.</span>');

    setEosTransport(recording(async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: POST /api/signals/sources/x/push" } })));
    await addSourcePush(PR, SRC);
    expect(draw()).toContain('role="alert">Not added: this is a dev run.</span>');

    setEosTransport(recording(async () => ({ ok: true, status: 200, body: { ...status.sources[0], push: "on" } })));
    expect(await addSourcePush(PR, SRC)).toBe(true);
    const html = section(draw(), "What starts it");
    expect(html).not.toContain(button);
    expect(html).not.toContain("eos-trigger__refused");
    expect(lines(html, "eos-trigger__facts")[1]).toMatch(/^Told at once by a webhook · Last looked /);
  });

  it("reads the status again on signals:change for its routine, and for every routine when it names none", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: {} }));
    await page(`eos:/routines/${PR}`, t);
    t.get.mockClear();
    applyEosEvent("signals:change", { routineId: MAIL, what: "source" });
    expect(t.get).not.toHaveBeenCalled();
    applyEosEvent("signals:change", { routineId: PR, what: "source" });
    expect(t.get.mock.calls.map((c) => c[0])).toEqual([ROUTES.signalsRoutine(PR), LIST]);
    t.get.mockClear();
    applyEosEvent("signals:change", { what: "settings" });
    expect(t.get.mock.calls.map((c) => c[0])).toEqual([ROUTES.signalsRoutine(PR), LIST]);
  });
});

describe("the signal list", () => {
  it("shows each signal with what became of it, the rule that turned one away, and filters by decision", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: {} }), { ...reads, [`${LIST}&decision=unmatched`]: [signals[1]] });
    let html = await page(`eos:/routines/${PR}?tab=signals`, t);
    expect(html).toContain('role="radiogroup" aria-label="Show signals"');
    expect(lines(html, "eos-signal__title")).toEqual(["Add a settings screen", "Bump the build tools", "Speed up the loader", "Add the inventory screen"]);
    expect(lines(html, "eos-signal__decision")).toEqual(["Over its limit", "Turned away by rule 1", "Ran", "There before it started"]);
    expect([...html.matchAll(/<span (?:data-tone="(\w+)" )?class="eos-signal__decision">/g)].map((m) => m[1] ?? null)).toEqual(["warn", null, "ok", null]);
    expect(html).toContain('<h2 class="eos-label">What came for it</h2><span class="eos-section__aside">4 signals · 1 ran</span>');
    // What starts it stands beside the list.
    expect(html).toContain('<h2 class="eos-label">What starts it</h2>');
    expect(html.match(/>Run it anyway</g)).toHaveLength(3);
    expect(html).toContain(">Open the run</button>");
    expect(html).not.toContain(">Run them<");

    await setSignalFilter(PR, "unmatched");
    expect(t.get).toHaveBeenLastCalledWith(`${LIST}&decision=unmatched`);
    html = draw();
    expect(html).toContain('role="radio" aria-checked="true" class="eos-seg__opt">Turned away</button>');
    expect(lines(html, "eos-signal__title")).toEqual(["Bump the build tools"]);
  });

  it("names the rule an unmatched signal failed, or the model's answer, never a rule it cannot count", () => {
    expect(decisionLine({ decision: "unmatched", reason: "2" })).toBe("Turned away by rule 3");
    expect(decisionLine({ decision: "unmatched", reason: "ask" })).toBe("Turned away by the model's answer");
    expect(decisionLine({ decision: "unmatched", reason: "other" })).toBe("Turned away");
    expect(decisionLine({ decision: "unmatched" })).toBe("Turned away");
  });

  it("runs one anyway and says what the core answered", async () => {
    const t = recording(async () => ({ ok: true, status: 200, body: [{ ...signals[1].decisions[0], decision: "run", runId: "rn-new" }] }));
    await page(`eos:/routines/${PR}?tab=signals`, t);
    expect(await replaySignals(PR, [40])).toBe(true);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.signalsReplay, { routineId: PR, signalIds: [40] });
    const html = draw();
    expect(html).toContain('<span class="eos-signal__replay" role="status">Running it now.</span>');
    expect(html.match(/>Run it anyway</g)).toHaveLength(2);
  });

  it("says a dev run refused it, and a toast for any other refusal", async () => {
    await page(`eos:/routines/${PR}?tab=signals`, recording(async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: POST /api/signals/replay" } })));
    expect(await replaySignals(PR, [41])).toBe(false);
    expect(draw()).toContain('<span class="eos-signal__replay" role="status">Not run: this is a dev run.</span>');

    const toast = vi.spyOn(notify, "error").mockImplementation(() => {});
    setEosTransport(recording(async () => ({ ok: false, status: 409, body: { error: "signal 39 started a run already" } })));
    expect(await replaySignals(PR, [39])).toBe(false);
    expect(toast).toHaveBeenCalledWith("signal 39 started a run already", { title: "Signals" });
    toast.mockRestore();
  });

  it("runs the over-limit, paused and baseline groups at once", async () => {
    const over = [signals[0], { ...signals[0], id: 43 }];
    const t = recording(async () => ({ ok: true, status: 200, body: over.map((s) => ({ ...s.decisions[0], decision: "run" })) }), { ...reads, [`${LIST}&decision=over-limit`]: over });
    await page(`eos:/routines/${PR}?tab=signals`, t);
    await setSignalFilter(PR, "over-limit");
    expect(draw()).toContain('<button type="button" class="eos-btn eos-btn--primary">Run them</button>');
    await replaySignals(PR, [41, 43]);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.signalsReplay, { routineId: PR, signalIds: [41, 43] });
    const html = draw();
    expect(html.match(/Running it now\./g)).toHaveLength(2);
    expect(html).not.toContain(">Run them<");
  });
});

describe("the blueprint's previews", () => {
  it("asks for a schedule's next times and shows them beside the When slot", async () => {
    const next = [1763532000000, 1763618400000, 1763704800000];
    const schedule = routineDetail.head.blueprint.when.on[1].schedule;
    const t = recording(async () => ({ ok: true, status: 200, body: { next } }));
    await page(`eos:/routines/${PR}?tab=blueprint`, t);
    await loadSchedulePreview(schedule, 3);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.signalsSchedulePreview, { schedule, count: 3 });
    expect(draw()).toContain(`<p class="eos-bp-preview">Next: ${next.map(timeAt).join(", ")}</p>`);
  });

  it("asks what the Which makes of recent signals and shows it beside the Which slot", async () => {
    const which = { rule: { all: [{ fact: "draft", is: false }, { fact: "files", gte: 2 }] }, ask: "Is it a real change?" };
    const withWhich = { ...routineDetail, head: { ...routineDetail.head, blueprint: { ...routineDetail.head.blueprint, which } } };
    const answer = { matched: [41, 39], unmatched: [{ rule: 0, signalIds: [40] }, { rule: 1, signalIds: [12, 11] }], undecided: [9], wouldAsk: 2 };
    const t = recording(async () => ({ ok: true, status: 200, body: answer }), { ...reads, [ROUTES.routine(PR)]: withWhich });
    await page(`eos:/routines/${PR}?tab=blueprint`, t);
    await loadWhichPreview(PR, which, 50);
    expect(t.send).toHaveBeenCalledWith("POST", ROUTES.signalsWhichPreview, { routineId: PR, which, limit: 50 });
    expect(draw()).toContain('<p class="eos-bp-preview">Of the last 6 signals: 2 taken, 1 turned away by rule 1, 2 turned away by rule 2, 1 missing a fact, 2 would be asked about.</p>');
  });
});
