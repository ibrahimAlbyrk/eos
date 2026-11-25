import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { rowOf } from "../../../state/eos/capabilitiesStore.js";
import { EosMain } from "../EosMain.jsx";
import { holdEosNavInMemory } from "../nav/eosNav.js";
import { EosSidebarRows } from "../sidebar/EosSidebar.jsx";
import { RunSheet } from "../runform/RunSheet.jsx";
import { QuickStage } from "./QuickStage.jsx";
import { SettingsStage } from "./SettingsStage.jsx";
import { UiProvider } from "../../../state/ui.jsx";
import { holdNetwork } from "./holdNetwork.js";
import { samplePageUrl } from "./samplePages.js";
import { api } from "../../../api/client.js";
import { AboutYouSlot } from "../memory/aboutYouSlot.js";
import { AboutYouTab } from "../memory/AboutYou.jsx";
import { aboutYouReads } from "./sample/about-you.js";
import routines from "./sample/routines.json";
import routineDetail from "./sample/routine-detail.json";
import routinePaused from "./sample/routine-paused.json";
import routineDraft from "./sample/routine-draft.json";
import blueprintDrafts from "./sample/blueprint-drafts.json";
import blueprintVersions from "./sample/blueprint-versions.json";
import blueprintVersionBodies from "./sample/blueprint-version-bodies.json";
import runsPageSample from "./sample/runs-page.json";
import candidates from "./sample/candidates.json";
import runDetailSample from "./sample/run-detail.json";
import runsSample from "./sample/runs.json";
import runResults from "./sample/run-results.json";
import inboxSample from "./sample/inbox.json";
import inboxItemsSample from "./sample/inbox-items.json";
import capabilities from "./sample/capabilities.json";
import signInFailed from "./sample/sign-in-failed.json";
import triggerStatusSample from "./sample/trigger-status.json";
import signalsSample from "./sample/signals.json";
import memory from "./sample/memory.json";
import surfaceSample from "./sample/surfaces.json";
import paper from "./sample/paper.json";
import decision from "./sample/surface-decision.json";
import { at5, HOME_PROFILE, HOME_SUMMARY, homeNext, homeRuns } from "./sample/home.js";
import { holdHomeInMemory, refreshHome, RUNS_PATH } from "../../../state/eos/homeStore.js";
import { notesPath } from "../../../state/eos/notesStore.js";
import { routineScope } from "../routine/WhatItLearned.jsx";
import { holdHomeDraftInMemory } from "../../../state/eos/homeDraftStore.js";
import { closeField, openField, setTransitionScale, useField } from "../field/fieldStore.js";
import { ENTER_MS } from "../field/transition.js";
import { failingTransport, GALLERY_STATES, loadingTransport, offlineTransport, stateOf, storedState, storeState } from "./states.js";
import { refreshInbox } from "../../../state/eos/inboxStore.js";

// Needs you's samples moved so the newest arrived twenty minutes before the
// gallery opened, the rest as far before it as recorded: times read "20m ago",
// never a year.
const MIN = 60 * 1000;
const shift = (row, by) => ({ ...row, createdAt: row.createdAt + by, updatedAt: row.updatedAt + by });
const newest = Math.max(...inboxSample.items.map((i) => i.createdAt));
const by = Date.now() - 20 * MIN - newest;
const inbox = { ...inboxSample, items: inboxSample.items.map((i) => shift(i, by)) };
const inboxItems = inboxItemsSample.map((d) => ({ ...d, item: shift(d.item, by) }));

// The runs' samples moved the same way, so the working run started three
// minutes before the gallery opened: every time named `…At` in them moves.
const later = (value, ms) => {
  if (Array.isArray(value)) return value.map((v) => later(v, ms));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k.endsWith("At") && typeof v === "number" ? v + ms : later(v, ms)]));
};
const working = runsSample.find((d) => d.run.state === "running");
const runsBy = Date.now() - 3 * MIN - working.run.startedAt;
const runs = later(runsSample, runsBy);
const runsPage = later(runsPageSample, runsBy);
const runDetail = later(runDetailSample, runsBy);

// PR Review's source last looked four minutes before the gallery opened; its
// triggers and signals move with it.
const signalsBy = Date.now() - 4 * MIN - triggerStatusSample[routineDetail.routine.id].sources[0].lastPollAt;
// PR Review's schedule runs on weekdays at 05:00: its last and next times are
// the weekdays at 05:00 around the moment the gallery opens.
const onWeekdays = (status) => ({
  ...status,
  schedules: status.schedules.map((sc) => ({ ...sc, nextAt: at5(Date.now(), 1, true), lastAt: at5(Date.now(), -1, true) })),
});
const shiftedStatus = later(triggerStatusSample, signalsBy);
const triggerStatus = { ...shiftedStatus, [routineDetail.routine.id]: onWeekdays(shiftedStatus[routineDetail.routine.id]) };
const signals = later(signalsSample, signalsBy);

// PR Review's week, so its page shows how it gets better.
// Its recent runs are the runs the gallery holds for it, newest first, so
// Right now shows the one working and the one waiting, and Recent runs
// those with the week's finished ones.
const RECENT = ["rn-running01", "rn-waiting01", "rn-shown01", "rn-trial01", "rn-failed01", "rn-cancelled01"];
const prRuns = RECENT.map((id) => runs.find((d) => d.run.id === id).run);
const withStats = {
  ...routineDetail,
  runs: prRuns,
  routine: { ...routineDetail.routine, stats: { sentUnedited7d: 0.86, baselineFirstWeek: 0.4, weeksBetween: [0.55, 0.68, 0.79], runs7d: 7, cost7d: 2.1, setupUsd: 0.5 } },
};

// What the gallery's reads answer, by the path each store asks. The routines
// hold one of each state, PR Review with its detail and runs, Mail Triage
// paused with its detail and an architect's change ready, Docs Review being
// made with its architect asking, and a run of
// PR Review in each state with the results of those shown only, and the
// pull requests it could run on; Needs you holds
// an item of each kind; the
// capabilities hold one of each state; GitHub's sign-in is one that did not work.
// PR Review's triggers show a schedule in another zone, a source after a
// catch-up and an open batch, with a signal of each group in its list; Mail
// Triage's source needs a sign-in. Memory holds notes learned for PR Review,
// a project and everywhere, one of them cooling, each routine's own read for
// its Learned tab; PR Review's run was given
// four of them. Morning Paper fills a page with three issues in two designs
// and a third version waiting to be kept; it and Build Watch are pinned.
// Home's day is drawn around the moment the gallery opens.
export const SAMPLE_READS = {
  [ROUTES.routines]: routines,
  [ROUTES.routine(routineDetail.routine.id)]: withStats,
  // Nine unedited sends in a row: one more brings the offer.
  [ROUTES.routineFreedom(routineDetail.routine.id)]: { routineId: routineDetail.routine.id, rung: "draft", grants: [], streak: 9, offer: "none" },
  [ROUTES.routine(routinePaused.routine.id)]: routinePaused,
  [ROUTES.routine(routineDraft.routine.id)]: routineDraft,
  ...Object.fromEntries(Object.entries(blueprintDrafts).map(([id, draft]) => [ROUTES.routineDraft(id), draft])),
  ...Object.fromEntries(Object.entries(blueprintVersions).map(([id, rows]) => [ROUTES.routineVersions(id), rows])),
  ...Object.fromEntries(Object.entries(blueprintVersionBodies).flatMap(([id, bodies]) => bodies.map((v) => [ROUTES.routineVersion(id, v.id), v]))),
  // Its Runs tab: the week's runs, then the older page.
  [`${ROUTES.runs}?routineId=${routineDetail.routine.id}&limit=50`]: { ...runsPage, runs: [...prRuns, ...runsPage.runs.filter((r) => !RECENT.includes(r.id))] },
  [`${ROUTES.routineCandidates(routineDetail.routine.id)}?limit=20`]: candidates,
  [ROUTES.run(runDetail.run.id)]: runDetail,
  ...Object.fromEntries(runs.map((detail) => [ROUTES.run(detail.run.id), detail])),
  ...Object.fromEntries(runResults.map((result) => [ROUTES.runResult(result.runId), result])),
  [ROUTES.inbox]: inbox,
  ...Object.fromEntries(inboxItems.map((detail) => [ROUTES.inboxItem(detail.item.id), detail])),
  [`${ROUTES.surfaces}?place=needs_you`]: { surfaces: [surfaceSample.surface] },
  [`${ROUTES.surfaceIssues(surfaceSample.surface.id)}?limit=20`]: { issues: [surfaceSample.issue], more: true },
  [ROUTES.surfaceIssue(surfaceSample.surface.id, surfaceSample.issue.id)]: { issue: surfaceSample.issue, body: surfaceSample.body },
  [ROUTES.surfaceIssue(decision.surface.id, decision.issue.id)]: { issue: decision.issue, body: decision.body },
  [ROUTES.surface(paper.surface.id)]: paper.surface,
  [`${ROUTES.surfaces}?routine=${paper.surface.routineId}`]: { surfaces: [paper.surface] },
  [`${ROUTES.surfaceIssues(paper.surface.id)}?limit=20`]: paper.issues,
  ...Object.fromEntries(Object.entries(paper.issueBodies).map(([id, one]) => [ROUTES.surfaceIssue(paper.surface.id, id), one])),
  [ROUTES.surfaceVersions(paper.surface.id)]: paper.versions,
  ...Object.fromEntries(Object.entries(paper.versionBodies).map(([n, one]) => [ROUTES.surfaceVersion(paper.surface.id, n), one])),
  [ROUTES.surfacePins]: paper.pins,
  [ROUTES.surfaceTiles]: paper.tiles,
  [ROUTES.capabilities]: capabilities.map(rowOf),
  ...Object.fromEntries(capabilities.map((detail) => [ROUTES.capability(detail.id), detail])),
  [ROUTES.capabilitySignIn("github")]: signInFailed,
  ...Object.fromEntries(Object.entries(triggerStatus).map(([id, status]) => [ROUTES.signalsRoutine(id), status])),
  [`${ROUTES.signals}?routine=${routineDetail.routine.id}`]: signals,
  [ROUTES.memorySummary]: memory.summary,
  [ROUTES.memoryNotes]: memory.notes,
  ...Object.fromEntries(routines.map((r) => [notesPath({ scope: routineScope(r.id) }), { notes: memory.notes.notes.filter((n) => n.scope.level === "routine" && n.scope.key === r.id) }])),
  ...Object.fromEntries(memory.details.map((detail) => [ROUTES.memoryNote(detail.note.id), detail])),
  [`${ROUTES.memoryRecalled}?runId=${memory.recalled.runId}`]: { notes: memory.recalled.notes },
  [ROUTES.profile]: HOME_PROFILE,
  [ROUTES.signalsSummary]: HOME_SUMMARY,
  [RUNS_PATH]: { runs: homeRuns(Date.now()) },
  [ROUTES.signalsRoutines]: homeNext(Date.now()),
};

// When a state's user acts: once its screen has drawn.
const AFTER_DRAWN_MS = 500;

// How long a reconnecting state draws its samples before it reads again.
const RECONNECT_AFTER_MS = 600;

// Slow plays the transition this many times longer (08 §10).
export const SLOW_K = 2.8;
// How long the field stays open in Play before it leaves again.
const HOLD_MS = 700;

// Plays Home → field → Home once, at `k`.
export function playTransition(k = 1) {
  setTransitionScale(k);
  openField();
  setTimeout(closeField, ENTER_MS * k + HOLD_MS);
}

// The gallery's own bar: which screen and state, and the transition's Play
// and Slow. It sits over Eos and is no part of it.
export function GalleryBar({ current, onPick }) {
  const [slow, setSlow] = useState(false);
  const play = () => {
    const k = slow ? SLOW_K : 1;
    document.querySelector(".eos-mode")?.style.setProperty("--k", String(k));
    playTransition(k);
  };
  return (
    <div className="eos-gallery-bar" role="toolbar" aria-label="Gallery">
      <select className="eos-gallery-bar__state" aria-label="Screen and state" value={current} onChange={(e) => onPick(e.target.value)}>
        {GALLERY_STATES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <button type="button" className="eos-gallery-bar__play" onClick={play}>Play</button>
      <label className="eos-gallery-bar__slow">
        <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> Slow
      </label>
    </div>
  );
}

// Another state: the gallery starts again in it, so every store reads afresh.
function pick(id) {
  storeState(id);
  location.reload();
}

// Eos's columns in the app's grid, the sidebar sliding out for the field as
// EosView does, and the run sheet App hosts, inside the app's UI context that
// a View draws in, with Memory's About you as the app hands it in. The chrome around them (the mode switcher, the account
// footer) reads the core, so the gallery leaves it out.
export function EosGallery({ state = "home" }) {
  const { on: fieldOn } = useField();
  const { quick, settings } = stateOf(state);
  if (quick || settings) {
    return (
      <UiProvider>
        <div className="app eos-mode">
          <GalleryBar current={state} onPick={pick} />
          {quick ? <QuickStage quick={quick} /> : <SettingsStage settings={settings} />}
        </div>
      </UiProvider>
    );
  }
  return (
    <UiProvider>
      <div className={fieldOn ? "app eos-mode eos-mode--field" : "app eos-mode"}>
        <GalleryBar current={state} onPick={pick} />
        <aside className="side">
          <div className="side-island side-island--agents"><EosSidebarRows /></div>
        </aside>
        <section className="center"><AboutYouSlot.Provider value={AboutYouTab}><EosMain /></AboutYouSlot.Provider></section>
        <RunSheet />
      </div>
    </UiProvider>
  );
}

// The #eos-gallery page (main.jsx): Eos drawn from sample JSON. It never calls
// the core: every read answers from a sample, every write is refused, and the
// app's own requests are held on the page, its memory reads answered from a
// sample. It
// opens in the state last picked in this tab (Home at first) and leaves where
// the user's own Eos opens untouched.
// The transport a gallery state reads through.
export function galleryTransport(state) {
  if (state.answer === "loading") return loadingTransport;
  if (state.answer === "error") return failingTransport;
  const read = fixtureTransport(state.reads ? state.reads(SAMPLE_READS) : SAMPLE_READS);
  const samples = state.sends ? { ...read, send: state.sends } : read;
  return state.answer === "offline" ? offlineTransport(samples) : samples;
}

export function startEosGallery(rootEl) {
  const state = stateOf(storedState());
  const held = aboutYouReads(Date.now());
  holdNetwork(globalThis, state.held ? state.held(held) : held);
  api.surfacePageUrl = samplePageUrl;
  setEosTransport(galleryTransport(state));
  holdEosNavInMemory(state.location);
  holdHomeInMemory();
  holdHomeDraftInMemory();
  createRoot(rootEl).render(<EosGallery state={state.id} />);
  // Reconnecting: once the screen has drawn, Home and Needs you read again
  // and hear nothing.
  if (state.then) setTimeout(state.then, AFTER_DRAWN_MS);
  if (state.answer === "offline") setTimeout(() => { void refreshHome(); void refreshInbox(); }, RECONNECT_AFTER_MS);
}
