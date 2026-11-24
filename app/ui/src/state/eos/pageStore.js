// pageStore — a routine's Page (05, 08 §4.11): the surface, its issues newest
// first, one issue's data, its design versions, and what the user does to it:
// edit a marked field, say how an issue was, reshape it by saying or pointing,
// keep or discard a candidate, bring an old version back.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { putBounded } from "./bounded.js";
import { isDevRunRefusal, transport } from "./transport.js";

const ISSUE_PAGE = 20;
const ISSUES_KEPT = 30;
const VERSIONS_KEPT = 20;

// pages: surface id → { surface, issues, more, failed } (issues null until read).
// issues: issue id → { issue, body } (or { failed }).
// versions: `${surfaceId}:${n}` → { meta, body, checks }.
// design: surface id → the newest surfaces:design { version, phase }.
// byRoutine: routine id → its Page's surface id, or null when it makes none.
// working: surface id → the run of its designer started from this window,
// until a version it made is checked or the user stops it.
const EMPTY = { pages: {}, issues: {}, versions: {}, design: {}, byRoutine: {}, working: {} };
let state = EMPTY;
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => state;

export function usePages() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function putPage(id, patch) {
  set({ pages: { ...state.pages, [id]: { ...(state.pages[id] ?? { surface: null, issues: null, more: false }), ...patch } } });
}

// The surface and its newest issues.
export async function loadPage(surfaceId) {
  const [one, list] = await Promise.all([
    transport.get(ROUTES.surface(surfaceId)),
    transport.get(`${ROUTES.surfaceIssues(surfaceId)}?limit=${ISSUE_PAGE}`),
  ]);
  if (!one.ok) {
    putPage(surfaceId, { failed: one.status === 404 ? "gone" : "error" });
    return;
  }
  putPage(surfaceId, {
    surface: one.body,
    issues: list.ok ? list.body?.issues ?? [] : [],
    more: list.ok ? Boolean(list.body?.more) : false,
    failed: null,
  });
}

// The next page of earlier issues.
export async function loadEarlierIssues(surfaceId) {
  const page = state.pages[surfaceId];
  const last = page?.issues?.at(-1);
  if (!last || !page.more) return;
  const r = await transport.get(`${ROUTES.surfaceIssues(surfaceId)}?before=${encodeURIComponent(last.id)}&limit=${ISSUE_PAGE}`);
  if (!r.ok) return;
  putPage(surfaceId, { issues: [...page.issues, ...(r.body?.issues ?? [])], more: Boolean(r.body?.more) });
}

export async function loadIssue(surfaceId, issueId) {
  const r = await transport.get(ROUTES.surfaceIssue(surfaceId, issueId));
  const value = r.ok ? { issue: r.body.issue, body: r.body.body } : { failed: true };
  set({ issues: putBounded(state.issues, issueId, value, ISSUES_KEPT) });
}

export const versionKey = (surfaceId, n) => `${surfaceId}:${n}`;

export async function loadVersion(surfaceId, n) {
  if (n == null || state.versions[versionKey(surfaceId, n)]) return;
  const r = await transport.get(ROUTES.surfaceVersion(surfaceId, n));
  if (r.ok) set({ versions: putBounded(state.versions, versionKey(surfaceId, n), r.body, VERSIONS_KEPT) });
}

// The routine's Page, for its routine page.
export async function loadRoutinePage(routineId) {
  const r = await transport.get(`${ROUTES.surfaces}?routine=${encodeURIComponent(routineId)}`);
  if (!r.ok) return;
  const page = (r.body?.surfaces ?? []).find((s) => s.level === "page" && !s.archivedAt) ?? null;
  set({ byRoutine: { ...state.byRoutine, [routineId]: page?.id ?? null } });
  if (page) await loadPage(page.id);
}

// The issue a location names (its number), else the newest ready issue that
// is no trial, else the newest of any.
export function pickIssue(issues, seq) {
  if (!issues?.length) return null;
  if (seq != null) return issues.find((i) => i.seq === seq) ?? null;
  return issues.find((i) => i.status === "ready" && !i.trial) ?? issues[0];
}

// A write's answer in words: null when it went, else why not.
function refusal(r, what) {
  if (r.ok) return null;
  if (isDevRunRefusal(r)) return "This is a dev run: nothing starts from here.";
  return r.body?.error ?? `${what} did not work (${r.status}).`;
}

async function sendAndReload(surfaceId, method, path, body, what) {
  const r = await transport.send(method, path, body);
  const why = refusal(r, what);
  if (!why) await loadPage(surfaceId);
  return { ok: !why, error: why, body: r.body };
}

// One edit in place on the revision the reader saw.
export async function editField(surfaceId, issueId, edit) {
  const r = await transport.send("PUT", ROUTES.surfaceIssueFields(surfaceId, issueId), edit);
  const why = refusal(r, "The edit");
  if (!why) set({ issues: putBounded(state.issues, issueId, { issue: r.body.issue, body: r.body.body }, ISSUES_KEPT) });
  return { ok: !why, error: why };
}

// "Good issue" or "Not today": the reader's verdict, told to memory.
export async function sendFeedback(issueId, verdict) {
  const body = { actionId: "surface.feedback", clientId: `dash-${issueId}-${verdict}`, state: { issue: issueId, verdict } };
  const r = await transport.send("POST", ROUTES.actionsRun, body);
  if (r.ok && r.body?.status === "done") return { ok: true };
  return { ok: false, error: r.ok ? r.body?.reason ?? "Eos did not take it." : refusal(r, "That") };
}

// Say what to change: the designer starts on `baseVersion` (202 { runId }).
export async function reshape(surfaceId, { baseVersion, instruction, part, index }) {
  const body = { baseVersion, instruction, ...(part ? { part } : {}), ...(index != null ? { index } : {}) };
  const r = await sendAndReload(surfaceId, "POST", ROUTES.surfaceReshape(surfaceId), body, "The change");
  if (r.ok && r.body?.runId) set({ working: { ...state.working, [surfaceId]: r.body.runId } });
  return r;
}

// Cancel: the designer's run stops, and nothing it had not proposed stays.
export async function stopReshape(surfaceId) {
  const runId = state.working[surfaceId];
  if (!runId) return;
  const { [surfaceId]: _, ...rest } = state.working;
  set({ working: rest });
  await transport.send("POST", ROUTES.runStop(runId), {});
}

// Remove, Move up or Move down a part: a new candidate, with no agent.
export function arrange(surfaceId, { baseVersion, part, op }) {
  return sendAndReload(surfaceId, "POST", ROUTES.surfaceArrange(surfaceId), { baseVersion, part, op }, "The change");
}

export const keepVersion = (surfaceId, n) => sendAndReload(surfaceId, "POST", ROUTES.surfaceVersionKeep(surfaceId, n), undefined, "Keeping it");
export const discardVersion = (surfaceId, n) => sendAndReload(surfaceId, "POST", ROUTES.surfaceVersionDiscard(surfaceId, n), undefined, "Going back");
export const restoreVersion = (surfaceId, n) => sendAndReload(surfaceId, "POST", ROUTES.surfaceVersionRestore(surfaceId, n), undefined, "Bringing it back");

// The mail as it would be sent, as HTML.
export async function mailPreview(surfaceId, issueId) {
  const r = await transport.getText(ROUTES.surfaceIssueMail(surfaceId, issueId));
  return r.ok && typeof r.body === "string" ? r.body : null;
}

// The issue as one file to share (D31): a document with no script.
export async function shareDocument(surfaceId, issueId) {
  const r = await transport.getText(`${ROUTES.surfaceIssueDocument(surfaceId, issueId)}?mode=share`);
  return r.ok && typeof r.body === "string" ? r.body : null;
}

// Regions that print on Letter; every other prints on A4.
const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH", "CL", "CO", "VE", "PR"]);

// The paper of the reader's region, from a locale such as "en-US".
export function paperOf(locale) {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale ?? "")?.[1]?.toUpperCase();
  return region && LETTER_REGIONS.has(region) ? "letter" : "a4";
}

// The issue printed to a PDF in the data folder: { ok, path } or why not.
export async function printIssue(surfaceId, issueId, locale) {
  const r = await transport.send("POST", ROUTES.surfaceIssuePdf(surfaceId, issueId), { paper: paperOf(locale) });
  return r.ok ? { ok: true, path: r.body.path } : { ok: false, error: refusal(r, "The PDF") };
}

// Shows a file the core wrote in Finder.
export const revealFile = (path) => transport.send("POST", ROUTES.fsReveal, { path });

// surfaces:change and surfaces:issue: read a loaded page again, and an
// issue on screen.
export function applyPageChange(payload) {
  const id = payload?.surfaceId;
  if (id && state.pages[id]) void loadPage(id);
  const issueId = payload?.issueId;
  if (issueId && state.issues[issueId]) void loadIssue(id, issueId);
}

// surfaces:design: where the designer's newest version stands.
export function applyDesignChange(payload) {
  const id = payload?.surfaceId;
  if (!id) return;
  const settled = payload.phase === "candidate" || payload.phase === "failed";
  const { [id]: _, ...rest } = state.working;
  set({ design: { ...state.design, [id]: { version: payload.version, phase: payload.phase } }, ...(settled ? { working: rest } : {}) });
  if (state.pages[id]) void loadPage(id);
}

export function resyncPages() {
  for (const id of Object.keys(state.pages)) void loadPage(id);
}

export function _resetPages() {
  state = EMPTY;
}
