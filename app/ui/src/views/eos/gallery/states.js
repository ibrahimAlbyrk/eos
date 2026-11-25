// The gallery's states (08 §10): each screen in each state it can be in,
// drawn from the samples. A state names where Eos opens and how the reads
// answer: the samples, the samples changed, nothing yet (loading), or a
// refusal (error). Nothing here reaches the core.

import { ROUTES } from "../../../api/routes.js";
import { RUNS_PATH } from "../../../state/eos/homeStore.js";
import inbox from "./sample/inbox.json";
import memory from "./sample/memory.json";
import paper from "./sample/paper.json";
import decision from "./sample/surface-decision.json";
import routineDetail from "./sample/routine-detail.json";
import routineDraft from "./sample/routine-draft.json";
import routinePaused from "./sample/routine-paused.json";
import runDetail from "./sample/run-detail.json";
import drafts from "./sample/blueprint-drafts.json";
import versionBodies from "./sample/blueprint-version-bodies.json";
import { NEEDS_STATES } from "./needsStates.js";
import { addHomeRuns, addOnce } from "../../../state/eos/homeRunsStore.js";
import { applyBlueprintChange, makeRoutine, saveBlueprint } from "../../../state/eos/blueprintStore.js";

const PAPER = paper.surface.id;
// Mail Triage's View that asks two things, arrived ten minutes before the
// gallery opened, first in Needs you.
function withDecision(s) {
  const at = Date.now() - 10 * 60 * 1000;
  const item = { ...decision.item, createdAt: at, updatedAt: at };
  const list = s[ROUTES.inbox];
  return { ...s, [ROUTES.inbox]: { ...list, items: [item, ...list.items] }, [ROUTES.inboxItem(item.id)]: { item, payload: {} } };
}

// The same View as a run hands it in without facts or an aside, from a run
// that read outside text.
function withPlainDecision(s) {
  const { facts, aside, ...body } = decision.body; // eslint-disable-line no-unused-vars
  const issue = ROUTES.surfaceIssue(decision.surface.id, decision.issue.id);
  return { ...withDecision(s), [issue]: { issue: decision.issue, body: { ...body, untrusted: true } } };
}

// Mail Triage's View answered, and Eos asking before it goes: on a click, or,
// for what cannot be taken back, once the user types the routine's name.
const pressButton = (text) => [...document.querySelectorAll(".eos-body button")].find((b) => b.textContent.trim().startsWith(text))?.click();
const eosAsks = (asked) => ({
  reads: withDecision,
  sends: async (method, path) => (path === ROUTES.actionsRun
    ? { ok: true, status: 202, body: { status: "confirm", recordId: "da-1", token: "t-1", ...asked } }
    : { ok: false, status: 403, body: { error: "sample data" } }),
  then: () => {
    pressButton("Through your iPhone");
    setTimeout(() => pressButton("Confirm"), 200);
  },
});

// Docs Review, being made, at each point of its making: the architect writing
// its first blueprint, and the blueprint ready after a trial on two items.
const DOCS = routineDraft.routine.id;
const DOCS_DRAFT = ROUTES.routineDraft(DOCS);
const writingDocs = (s) => ({
  ...s,
  [DOCS_DRAFT]: { ...drafts[DOCS], status: "working", question: undefined, choices: [], draftVersionId: undefined, changed: [] },
  [ROUTES.routineVersions(DOCS)]: [],
});
const trial = (id, itemTitle, headline) => ({
  id, routineId: DOCS, kind: "trial", origin: "trial", state: "done", headline, itemTitle, needsUser: false, costUsd: 0.18, workMs: 64000,
  createdAt: Date.now() - 9 * 60 * 1000, startedAt: Date.now() - 9 * 60 * 1000, endedAt: Date.now() - 8 * 60 * 1000,
});
const readyDocs = (s) => ({
  ...s,
  [DOCS_DRAFT]: {
    ...drafts[DOCS], status: "ready", question: undefined, choices: [],
    trialRuns: [trial("rn-dtrial000001", "Fix broken links in the setup guide", "Two comments, one of them blocking"), trial("rn-dtrial000002", "Rename the CLI flags in the reference", "Nothing a reader is told changes")],
  },
});
// Docs Review while the architect writes, then its first version arriving:
// the reads change under the screen and the routine's change is announced,
// as the core does, so the slots fill as they would in the app.
let written = null;
const writtenDocs = (s) => {
  written = { reads: writingDocs(s), samples: s };
  return written.reads;
};
const writtenArrives = () => setTimeout(() => {
  if (!written) return;
  Object.assign(written.reads, readyDocs(written.samples));
  applyBlueprintChange({ routineId: DOCS });
}, 1400);
// Docs Review made to post in Slack, with Add a Slack channel or person open
// on what Slack lists: the picker with its channels and a person.
const candidates = (item) => `${ROUTES.capabilityCandidates}?${new URLSearchParams({ item, limit: "20" })}`;
const slackDocs = (s) => {
  const body = versionBodies[DOCS][0];
  const blueprint = { ...body.blueprint, makes: { kind: "slack.message", description: "A message in the channel with what changed." } };
  return {
    ...readyDocs(s),
    [ROUTES.routineVersion(DOCS, body.id)]: { ...body, blueprint },
    [candidates("slack.conversation")]: [
      { key: "C0DOCS0001", kind: "slack.conversation", title: "#docs", updatedAt: 0, data: { kind: "channel" } },
      { key: "C0RELEASE1", kind: "slack.conversation", title: "#release-notes", updatedAt: 0, data: { kind: "channel" } },
      { key: "C0WRITERS1", kind: "slack.conversation", title: "#writers", updatedAt: 0, data: { kind: "channel" } },
    ],
    [candidates("slack.person")]: [{ key: "U0MAYA0001", kind: "slack.person", title: "Maya Lindqvist", updatedAt: 0, data: { name: "maya" } }],
  };
};
const slackOpen = () => setTimeout(() => {
  [...document.querySelectorAll(".eos-bp-card button.eos-bp-add")].find((b) => /slack/i.test(b.textContent))?.click();
}, 300);
// A hand edit of Docs Review the rules refused, naming its Which and Goes to.
const refusedEdit = {
  sends: async () => ({ ok: false, status: 400, body: { error: "the blueprint does not meet its rules", issues: [
    { path: ["which", "ask"], message: "a question needs a model to ask it", severity: "error" },
    { path: ["goesTo", 1], message: "a channel needs its Slack sign-in", severity: "error" },
  ] } }),
  then: () => {
    const body = versionBodies[DOCS][0];
    void saveBlueprint(DOCS, body.id, body.blueprint);
  },
};
// Three architects at work when a fourth routine is asked for.
const crowded = {
  sends: async () => ({ ok: false, status: 409, body: { error: "too many architects are at work; finish or leave one first", code: "architects_busy", drafts: [{ id: DOCS, name: "Docs Review" }] } }),
  then: () => void makeRoutine("Tell me when the build breaks"),
};

// A routine file dragged onto New routine, or dropped there: the drop
// target, the dialog that asks, and a file that is no routine.
const ROUTINE_FILE = JSON.stringify({ format: 1, routine: { name: "Docs Review" }, versions: [{}, {}, {}] });
const dragFile = (name, text, kind) => () => {
  const into = document.querySelector(".eos-new-drop");
  if (!into) return;
  const data = new DataTransfer();
  data.items.add(new File([text], name, { type: "application/json" }));
  into.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
  if (kind === "drop") into.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
};
const importing = {
  dragging: { then: dragFile("docs-review.json", ROUTINE_FILE, "over") },
  asking: { then: dragFile("docs-review.json", ROUTINE_FILE, "drop") },
  refused: {
    sends: async () => ({ ok: false, status: 400, body: { error: "this file was written by a newer Eos" } }),
    then: () => {
      dragFile("docs-review.json", ROUTINE_FILE, "drop")();
      setTimeout(() => [...document.querySelectorAll(".eos-ask button")].find((b) => b.textContent === "Make the draft")?.click(), 300);
    },
  },
  wrong: { then: dragFile("notes.txt", "Buy milk", "drop") },
};

// PR Review as it can also stand: nothing running and no week judged yet,
// its last run failed, or archived.
const PR = routineDetail.routine.id;
const prWith = (s, change) => {
  const detail = s[ROUTES.routine(PR)];
  const next = change(detail);
  return { ...s, [ROUTES.routine(PR)]: next, [ROUTES.routines]: s[ROUTES.routines].map((r) => (r.id === PR ? { ...r, ...next.routine } : r)) };
};
const quietPr = (s) => prWith(s, (d) => ({ ...d, runs: d.runs.filter((r) => r.state === "done").slice(0, 1), routine: { ...d.routine, stats: undefined, activeRuns: 0 } }));
const failedPr = (s) => prWith(s, (d) => {
  const failed = d.runs.find((r) => r.state === "failed");
  const at = (r) => r.createdAt ?? 0;
  const ended = d.runs.filter((r) => r !== failed && at(r) < at(failed) && ["done", "cancelled", "failed"].includes(r.state));
  return { ...d, runs: [failed, ...ended], routine: { ...d.routine, lastRun: failed, activeRuns: 0 } };
});
// PR Review held by another Mac: there, and away since the day before.
const heldPr = (awaySince) => (s) => ({
  ...s,
  [ROUTES.runners]: { deviceId: "mbp", devices: [{ deviceId: "air", name: "MacBook Air", seenAt: Date.now() - 60 * 1000, awaySince, routines: [PR] }], confirmedAt: Date.now() },
});
// Resume of the paused routine refused until two new recipients are confirmed.
const unconfirmedResume = {
  sends: async () => ({ ok: false, status: 409, body: {
    error: "Two recipients are new since this routine last ran. Confirm them before it sends again.",
    code: "recipients_unconfirmed",
    recipients: [{ id: "c-maya", label: "Maya Lindqvist (Slack)" }, { id: "c-release", label: "#release-notes (Slack)" }],
  } }),
  then: () => [...document.querySelectorAll(".eos-rlead__acts button")].find((b) => b.textContent === "Resume")?.click(),
};
const archivedPr = (s) => prWith(s, (d) => ({ ...d, runs: d.runs.filter((r) => ["done", "cancelled", "failed"].includes(r.state)), routine: { ...d.routine, state: "archived", activeRuns: 0, lastRun: d.runs.find((r) => r.state === "done") } }));

// The working run with a team of six: three more specialists, one of them
// done, one starting, one with a long line of what it does.
const crowdedRun = (s) => {
  const path = ROUTES.run("rn-running01");
  const detail = s[path];
  const more = [
    { workerId: "w-x1", role: "specialist", name: "Shader specialist", model: "claude-sonnet-4-5", state: "WORKING", costUsd: 0.08, lastActivity: "comparing ShopCarousel.shader against the paging change in CarouselPager.cs and the snapshot tests" },
    { workerId: "w-x2", role: "specialist", name: "Test writer", model: "claude-haiku-4-5", state: "DONE", costUsd: 0.03, lastActivity: "wrote three paging tests" },
    { workerId: "w-x3", role: "checker", model: "claude-haiku-4-5", state: "SPAWNING" },
  ];
  return { ...s, [path]: { ...detail, agents: [...detail.agents, ...more] } };
};

// PR Review as a project (01 G10): seven milestones, its newest run at the
// fourth, or done with all of them.
const MILESTONES = [
  "Read the shop's code and its tests", "Plan the paging change", "Move the pager to its own module",
  "Rework the carousel paging", "Add paging tests", "Check it on a slow device", "Open the pull request",
].map((title, i) => ({ key: `m${i + 1}`, title }));
const projectPrAt = (state, done) => (s) => prWith(s, (d) => {
  const head = { ...d.head, blueprint: { ...d.head.blueprint, kind: "project", project: { repo: "acme/game", milestones: MILESTONES } } };
  const lastRun = { ...d.runs[0], kind: "project", state, milestonesDone: done };
  return { ...d, head, runs: [lastRun, ...d.runs.slice(1)], routine: { ...d.routine, kind: "project", lastRun } };
});
const projectPr = projectPrAt("running", 3);
const projectPrDone = projectPrAt("done", 7);

// PR Review's run sheet, opened from Run now on its page, then what the
// user did in it: typed in the item, opened Later, or pressed Run and was
// refused or asked about a repeat.
const press = (selector, text) => [...document.querySelectorAll(selector)].find((b) => b.textContent.trim().startsWith(text))?.click();
const typeInto = (input, text) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const sheet = (after = () => {}) => () => {
  press(".eos-head__side button", "Run now");
  setTimeout(after, 400);
};
const sheetRefused = (answer) => ({
  sends: async (method, path) => (path === ROUTES.runs ? answer : { ok: false, status: 403, body: { error: "sample data" } }),
  then: sheet(() => press(".eos-runform button", "Run")),
});
const sheeting = {
  open: { then: sheet() },
  list: {
    reads: (s) => {
      const all = `${ROUTES.routineCandidates(PR)}?limit=20`;
      return { ...s, [`${all}&q=%234`]: s[all] };
    },
    then: sheet(() => { const input = document.getElementById("runform-item"); input.focus(); typeInto(input, "#4"); }),
  },
  later: { then: sheet(() => press(".eos-runform .eos-seg__opt", "Later")) },
  refused: sheetRefused({ ok: false, status: 409, body: { error: "day cap", code: "day_cap" } }),
  repeat: sheetRefused({ ok: false, status: 409, body: { existingRunId: "rn-shown01" } }),
};

// What the shortcut holds when the user selected text and a link in Safari.
const QUICK_SELECTION = {
  source: "shortcut",
  app: "Safari",
  parts: [
    { kind: "text", text: "Shader variant stripping cuts the build by a third, with the numbers below" },
    { kind: "url", url: "https://example.com/shaders" },
  ],
};

// The draft answered five minutes before the gallery opened, last of all.
const answered = (s) => {
  const item = s[ROUTES.inboxItem("ib-8m2n6b0v4c1x")].item;
  return { ...empty, items: [{ ...item, state: "answered", updatedAt: Date.now() - 5 * 60 * 1000 }] };
};
const empty = { ...inbox, items: [], counts: { open: 0, later: 0, byKind: {}, byRoutine: {} } };

// { id, label, location, reads: (samples) → reads, answer?: "loading" | "error" | "offline",
//   sends?: how writes answer instead of the refusal, then?: what the user did once it drew }
export const GALLERY_STATES = [
  { id: "home", label: "Home · typical", location: "eos:/" },
  { id: "home-empty", label: "Home · nothing waiting", location: "eos:/", reads: (s) => ({ ...s, [ROUTES.inbox]: empty, [RUNS_PATH]: { runs: [] }, [ROUTES.surfaceTiles]: { tiles: [] } }) },
  { id: "home-first", label: "Home · first run", location: "eos:/", reads: (s) => ({ ...s, [ROUTES.routines]: [], [RUNS_PATH]: { runs: [] }, [ROUTES.inbox]: empty, [ROUTES.signalsRoutines]: [], [ROUTES.surfaceTiles]: { tiles: [] } }) },
  { id: "home-loading", label: "Home · loading", location: "eos:/", answer: "loading" },
  { id: "home-error", label: "Home · cannot read", location: "eos:/", answer: "error" },
  { id: "home-offline", label: "Home · reconnecting", location: "eos:/", answer: "offline" },
  { id: "home-live", label: "Home · four runs started from the input, one dropped", location: "eos:/", then: () => {
    addHomeRuns([{ id: "rn-checking01", routineId: PR }]);
    addHomeRuns(["rn-waiting01", "rn-queued01"].map((id) => ({ id, routineId: PR })));
    addHomeRuns([{ id: "rn-running01", routineId: PR }], { stoppable: true });
  } },
  { id: "home-once", label: "Home · two tasks done once", location: "eos:/", then: () => {
    addOnce({ routineId: PR, name: "Summarise this week's merged pull requests", runId: "rn-running01" });
    addOnce({ routineId: PR, name: "Review the naming in the shop UI", runId: "rn-shown01" });
  } },
  { id: "needs", label: "Needs you", location: "eos:/needs" },
  { id: "needs-empty", label: "Needs you · empty", location: "eos:/needs", reads: (s) => ({ ...s, [ROUTES.inbox]: empty, [`${ROUTES.inbox}?state=answered`]: answered(s) }) },
  { id: "need", label: "Needs you · a draft", location: `eos:/needs/${inbox.items.find((i) => i.kind === "draft")?.id}` },
  { id: "need-offline", label: "Needs you · a draft, reconnecting", location: `eos:/needs/${inbox.items.find((i) => i.kind === "draft")?.id}`, answer: "offline" },
  { id: "need-view", label: "Needs you · a View that asks", location: `eos:/needs/${decision.item.id}`, reads: withDecision },
  { id: "need-view-plain", label: "Needs you · a View with no facts or aside, from outside text", location: `eos:/needs/${decision.item.id}`, reads: withPlainDecision },
  { id: "need-view-confirm", label: "Needs you · a View answered, Eos asks first", location: `eos:/needs/${decision.item.id}`, ...eosAsks({ prompt: "Eos will text your own number through your iPhone, at most five times a day. Go ahead?" }) },
  { id: "need-view-type", label: "Needs you · a View answered, Eos asks for the routine's name", location: `eos:/needs/${decision.item.id}`, ...eosAsks({ prompt: "This lets Mail Triage text you from now on and cannot be taken back from here.", typeToConfirm: "Mail Triage" }) },
  ...NEEDS_STATES,
  { id: "link", label: "A link wants to start a run", location: "eos:/form?routine=pr-review&item=%23470&opt.depth=deep&showOnly=1&from=link" },
  { id: "link-unknown", label: "A link names no routine", location: "eos:/form?routine=release-train&item=v2.4&from=link" },
  { id: "quick", label: "Quick panel · opened empty", location: "eos:/", quick: {} },
  { id: "quick-selection", label: "Quick panel · holding a selection", location: "eos:/", quick: { item: QUICK_SELECTION } },
  { id: "quick-dock", label: "Quick panel · a file dropped on the Dock", location: "eos:/", quick: { item: { source: "dock", app: null, parts: [{ kind: "file", path: "/Users/ada/build-report-1182.txt" }] } } },
  { id: "quick-access", label: "Quick panel · Accessibility not allowed", location: "eos:/", quick: { trusted: false } },
  { id: "quick-offer", label: "Quick panel · Start at login offered", location: "eos:/", quick: { item: QUICK_SELECTION, offered: false } },
  { id: "routines", label: "Routines", location: "eos:/routines" },
  { id: "routines-loading", label: "Routines · loading", location: "eos:/routines", answer: "loading" },
  { id: "routines-error", label: "Routines · cannot read", location: "eos:/routines", answer: "error" },
  { id: "routines-empty", label: "Routines · none yet", location: "eos:/routines", reads: (s) => ({ ...s, [ROUTES.routines]: [] }) },
  { id: "routines-none-active", label: "Routines · every one paused", location: "eos:/routines", reads: (s) => ({ ...s, [ROUTES.routines]: s[ROUTES.routines].map((r) => ({ ...r, state: "paused" })) }) },
  { id: "routine", label: "Routine · active", location: `eos:/routines/${routineDetail.routine.id}` },
  { id: "routine-paused", label: "Routine · paused", location: `eos:/routines/${routinePaused.routine.id}` },
  { id: "routine-quiet", label: "Routine · nothing running, no week yet", location: `eos:/routines/${PR}`, reads: quietPr },
  { id: "routine-failed", label: "Routine · its last run failed", location: `eos:/routines/${PR}`, reads: failedPr },
  { id: "routine-held", label: "Routine · runs on another Mac", location: `eos:/routines/${PR}`, reads: heldPr(undefined) },
  { id: "routine-held-away", label: "Routine · its Mac is away", location: `eos:/routines/${PR}`, reads: heldPr(Date.now() - 26 * 60 * 60 * 1000) },
  { id: "routine-unconfirmed", label: "Routine · Resume waits for recipients", location: `eos:/routines/${routinePaused.routine.id}`, ...unconfirmedResume },
  { id: "routine-archived", label: "Routine · archived", location: `eos:/routines/${PR}`, reads: archivedPr },
  { id: "routine-project", label: "Routine · a project at step four of seven", location: `eos:/routines/${PR}`, reads: projectPr },
  { id: "routine-project-done", label: "Routine · a project, every step done", location: `eos:/routines/${PR}`, reads: projectPrDone },
  { id: "runsheet", label: "Run sheet · from Run now", location: `eos:/routines/${PR}`, ...sheeting.open },
  { id: "runsheet-list", label: "Run sheet · the item's candidates", location: `eos:/routines/${PR}`, ...sheeting.list },
  { id: "runsheet-later", label: "Run sheet · Later", location: `eos:/routines/${PR}`, ...sheeting.later },
  { id: "runsheet-refused", label: "Run sheet · refused, the day's budget spent", location: `eos:/routines/${PR}`, ...sheeting.refused },
  { id: "runsheet-repeat", label: "Run sheet · this item ran lately", location: `eos:/routines/${PR}`, ...sheeting.repeat },
  { id: "routine-runs", label: "Routine · Runs", location: `eos:/routines/${PR}?tab=runs` },
  { id: "routine-signals", label: "Routine · Signals", location: `eos:/routines/${PR}?tab=signals` },
  { id: "routine-signals-empty", label: "Routine · Signals, nothing came yet", location: `eos:/routines/${PR}?tab=signals`, reads: (s) => ({ ...s, [`${ROUTES.signals}?routine=${PR}`]: [] }) },
  { id: "routine-learned", label: "Routine · Learned", location: `eos:/routines/${PR}?tab=learned` },
  { id: "routine-loading", label: "Routine · loading", location: `eos:/routines/${PR}`, answer: "loading" },
  { id: "routine-making", label: "Routine · being made, the architect asking", location: `eos:/routines/${routineDraft.routine.id}?tab=blueprint` },
  { id: "routine-change", label: "Routine · a change to look at", location: `eos:/routines/${routinePaused.routine.id}?tab=blueprint` },
  { id: "routine-writing", label: "Routine · being made, the architect writing", location: `eos:/routines/${DOCS}`, reads: writingDocs },
  { id: "routine-ready", label: "Routine · being made, tried and ready", location: `eos:/routines/${DOCS}`, reads: readyDocs },
  { id: "routine-written", label: "Routine · being made, its first version arriving", location: `eos:/routines/${DOCS}`, reads: writtenDocs, then: writtenArrives },
  { id: "routine-slack", label: "Routine · being made, adding a Slack channel", location: `eos:/routines/${DOCS}`, reads: slackDocs, then: slackOpen },
  { id: "routine-refused", label: "Routine · being made, an edit refused", location: `eos:/routines/${DOCS}`, ...refusedEdit },
  { id: "version-old", label: "Routine · an earlier version", location: `eos:/routines/${routinePaused.routine.id}/versions/1` },
  { id: "new-routine", label: "New routine", location: "eos:/routines/new" },
  { id: "new-routine-said", label: "New routine · from a starter on Routines", location: "eos:/routines/new?say=Tell%20me%20when%20the%20build%20breaks" },
  { id: "import-dragging", label: "New routine · a routine file dragged over", location: "eos:/routines/new", ...importing.dragging },
  { id: "import-asking", label: "New routine · a routine file asks first", location: "eos:/routines/new", ...importing.asking },
  { id: "import-refused", label: "New routine · a routine file refused", location: "eos:/routines/new", ...importing.refused },
  { id: "import-wrong", label: "New routine · a file that is no routine", location: "eos:/routines/new", ...importing.wrong },
  { id: "new-routine-crowded", label: "New routine · three architects at work", location: "eos:/routines/new", ...crowded },
  { id: "routine-error", label: "Routine · cannot read", location: `eos:/routines/${routineDetail.routine.id}`, answer: "error" },
  { id: "run", label: "Run", location: `eos:/runs/${runDetail.run.id}` },
  { id: "run-running", label: "Run · working", location: "eos:/runs/rn-running01" },
  { id: "run-waiting", label: "Run · waiting for you", location: "eos:/runs/rn-waiting01" },
  { id: "run-failed", label: "Run · failed", location: "eos:/runs/rn-failed01" },
  { id: "run-queued", label: "Run · queued", location: "eos:/runs/rn-queued01" },
  { id: "run-checking", label: "Run · being checked", location: "eos:/runs/rn-checking01" },
  { id: "run-shown", label: "Run · done, shown to you only", location: "eos:/runs/rn-shown01" },
  { id: "run-trial", label: "Run · a trial", location: "eos:/runs/rn-trial01" },
  { id: "run-paused", label: "Run · paused by the day's limit", location: "eos:/runs/rn-paused01" },
  { id: "run-cancelled", label: "Run · stopped by you", location: "eos:/runs/rn-cancelled01" },
  { id: "run-crowded", label: "Run · a team of six", location: "eos:/runs/rn-running01", reads: crowdedRun },
  { id: "run-loading", label: "Run · loading", location: "eos:/runs/rn-running01", answer: "loading" },
  { id: "run-error", label: "Run · cannot read", location: "eos:/runs/rn-running01", answer: "error" },
  { id: "run-gone", label: "Run · no longer here", location: "eos:/runs/rn-gone" },
  { id: "memory", label: "Memory", location: "eos:/memory" },
  { id: "memory-note", label: "Memory · a note open", location: `eos:/memory?tab=work&note=${memory.details.find((d) => d.note.text.startsWith("Run lint"))?.note.id ?? memory.details[0].note.id}` },
  { id: "memory-about", label: "Memory · About you", location: "eos:/memory?tab=about" },
  { id: "capabilities", label: "Capabilities", location: "eos:/capabilities" },
  { id: "capabilities-empty", label: "Capabilities · none yet", location: "eos:/capabilities", reads: (s) => ({ ...s, [ROUTES.capabilities]: [] }) },
  { id: "page", label: "Page · today's issue", location: `eos:/surfaces/${PAPER}` },
  { id: "page-old", label: "Page · an earlier issue", location: `eos:/surfaces/${PAPER}?issue=1` },
  { id: "page-redesign", label: "Page · needs a new design", location: `eos:/surfaces/${PAPER}`, reads: (s) => ({ ...s, [ROUTES.surface(PAPER)]: { ...paper.surface, needsRedesign: { since: 1 } } }) },
  { id: "page-reshape", label: "Page · changing it", location: `eos:/surfaces/${PAPER}?mode=reshape` },
  { id: "page-candidate", label: "Page · a new version to keep", location: `eos:/surfaces/${PAPER}?mode=reshape`, reads: (s) => ({ ...s, [ROUTES.surface(PAPER)]: { ...paper.surface, candidateVersion: 3 } }) },
  { id: "page-empty", label: "Page · no issue yet", location: `eos:/surfaces/${PAPER}`, reads: (s) => ({ ...s, [`${ROUTES.surfaceIssues(PAPER)}?limit=20`]: { issues: [], more: false } }) },
];

export const stateOf = (id) => GALLERY_STATES.find((s) => s.id === id) ?? GALLERY_STATES[0];

// Reads that never answer: every screen shows its loading state.
export const loadingTransport = {
  get: () => new Promise(() => {}),
  send: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
  upload: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
};

// Reads the core turns away: every screen shows that it could not read.
export const failingTransport = {
  get: async () => ({ ok: false, status: 500, body: { error: "sample failure" } }),
  send: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
  upload: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
};

// Reads the core answers once and then stops answering: every screen first
// draws the samples, then shows that it is reconnecting when it reads again.
export function offlineTransport(answering) {
  const asked = new Set();
  return {
    get: (path) => {
      if (asked.has(path)) return Promise.reject(new Error("no answer"));
      asked.add(path);
      return answering.get(path);
    },
    send: () => Promise.reject(new Error("no answer")),
    upload: () => Promise.reject(new Error("no answer")),
  };
}

export const GALLERY_STATE_KEY = "eos:galleryState";

export function storedState() {
  try {
    return sessionStorage.getItem(GALLERY_STATE_KEY);
  } catch {
    return null;
  }
}

export function storeState(id) {
  try {
    sessionStorage.setItem(GALLERY_STATE_KEY, id);
  } catch {}
}
