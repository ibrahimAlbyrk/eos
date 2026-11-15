// eventsStore — per-agent event window cache with backward pagination and
// read-ahead. Windows live here (module scope), not in the hook, so
// a loaded transcript survives agent switches: switching back renders the
// cached window synchronously and a tail fetch catches it up.
//
// Live updates: every change event for a worker (useLive → notifyWorkerChanged)
// pulls the rows after the newest one held. The poll only stands in while the
// stream is down.
//
// Read-ahead: the rows just older than the window wait in `parked`, in memory
// but not rendered, so the scroll-up sentinel's loadOlder prepends them
// synchronously — no network wait on the user-visible path. A chat followed
// from its tail parks one page. Once the reader scrolls up into history, older
// pages are read in the background and join the window as they land, until it
// holds EAGER_HISTORY_ROWS: for all but the longest chats the top of the
// transcript is then the start of the conversation. Past that, history pages in
// as the reader reaches it, one parked page ahead. Rows the live window trims go
// back to `parked`, so paging them in again costs no request either.
//
// Ownership invariant: every row lands in the entry keyed by the workerId it
// was fetched for (plus the filterOwnRows defense), so one agent's transcript
// can never bleed into another's — the cross-agent thinking-leak class of bug.

import { api } from "../api/client.js";
import { bootActive } from "../api/boot.js";
import { startPolling } from "../lib/pollInterval.js";
import { isRemoteView } from "../lib/host.js";
import { rowPayload } from "../lib/toolLifecycle.js";
import { isStreamLive } from "./streamStatus.js";

export const PAGE_SIZE = 500;
// An older page is several times the newest one: a working turn is hundreds of
// rows that render as a handful of blocks, and history is read in the
// background, where the round trips are what costs. A view of another Mac
// keeps the small page: its rows cross a relay.
export const OLDER_PAGE_SIZE = 2000;
const olderPageSize = () => (isRemoteView() ? PAGE_SIZE : OLDER_PAGE_SIZE);
// How much one step moves from `parked` into the window: enough to add
// something to see, small enough that the commit rendering it stays short. A
// turn is what the transcript draws a few blocks for, however many rows it
// logged, so a step ends at whichever bound it meets first. The view asks for
// the next step while its sentinel is still in reach.
export const OLDER_STEP = 1000;
export const OLDER_STEP_TURNS = 12;
const PROMPT_TYPES = new Set(["user_message", "orchestrator_message"]);
// How much history a reader gets without asking. A chat keeps its whole log, so
// this bounds what scrolling up a little may bring into memory and into every
// later parse of the window.
export const EAGER_HISTORY_ROWS = 20_000;
// A failed older page holds the next attempt back this long.
export const OLDER_RETRY_MS = 1000;
const POLL_MS = 5000;
// Cache bounds: windows of detached (switched-away) agents survive for
// instant switch-back — at most MAX_CACHED_WORKERS of them, each trimmed to
// its newest MAX_DETACHED_EVENTS rows (a trim re-opens hasOlder).
const MAX_CACHED_WORKERS = 5;
const MAX_DETACHED_EVENTS = 3 * PAGE_SIZE;
// Live-window bound. While a pane follows the tail, keep only the newest
// MAX_ATTACHED_EVENTS materialized — without this an actively-watched,
// long-running agent grows the window (and the rendered DOM) without limit,
// the web UI's unbounded-memory leak. A view that needed more than that to
// fill its screen (it paged older rows in while following) keeps that many.
// A reader scrolled up into history keeps everything they paged in: the rows a
// trim drops are the oldest ones, the very rows they are reading. Returning to
// the tail trims again.
const MAX_ATTACHED_EVENTS = 4 * PAGE_SIZE;
const FILL_IDLE_MS = 200;
// Rows of one turn land in bursts; one tail fetch per burst.
const CHANGE_DEBOUNCE_MS = 50;

// WKWebView has no requestIdleCallback; a short timeout approximates "after
// the current interaction settles".
const idle = typeof requestIdleCallback === "function"
  ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
  : (fn) => setTimeout(fn, FILL_IDLE_MS);

// Union by id; incoming rows win (payloads get patched in place server-side,
// e.g. usage delta-cost back-fill). Sorted by (ts, id) — id is the same-ms
// insertion-order tiebreaker the tool-lifecycle barriers depend on.
export function mergeEvents(current, incoming) {
  if (current.length === 0) return [...incoming];
  if (incoming.length === 0) return current;
  const byId = new Map();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

// The server already filters by worker_id; this client-side boundary turns a
// regression anywhere in that chain into a dropped row plus a console warning
// instead of a silent cross-agent transcript leak.
export function filterOwnRows(workerId, rows) {
  const own = rows.filter((r) => r.worker_id === workerId);
  if (own.length !== rows.length) {
    console.warn(`[eventsStore] dropped ${rows.length - own.length} foreign event row(s) fetched for ${workerId}`);
  }
  return own;
}

const EMPTY_SNAPSHOT = Object.freeze({
  events: Object.freeze([]),
  eventsFor: null,
  hasOlder: false,
  loadingOlder: false,
});

const entries = new Map(); // workerId → entry; insertion order doubles as LRU recency

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (!e) {
    e = {
      workerId,
      events: [],
      // Rows older than the window, contiguous with it, oldest first.
      parked: [],
      // Whether the core holds rows older than everything held here. Decided by
      // the FIRST page for a worker and by older pages only — newest refetches
      // always return a full page on long transcripts and must not resurrect an
      // exhausted cursor.
      serverMore: false,
      // The window size a following view paged up to (see capWindow).
      keep: 0,
      loaded: false,
      // The newest page came from the boot snapshot (primeNewest), not yet attached.
      primed: false,
      // following = the view is pinned to the tail; gates live-window trimming
      // (see capWindow). Defaults true so an unwired pane is still bounded.
      following: true,
      loadingOlder: false,
      // Rows a waiting loadOlder takes once its pages have landed, and how far
      // back it reads first (a row time; null = the next page is enough).
      wantRows: 0,
      wantUntilTs: null,
      filling: false,
      draining: false,
      fillScheduled: false,
      // Bumped when the oldest held row changes other than by a page landing:
      // a page asked for before that no longer joins what is held.
      fillGen: 0,
      attachers: 0,
      subs: new Set(),
      newestListeners: new Set(),
      pollStop: null,
      pollAbort: null,
      changeTimer: null,
      // Tail fetch single-flight: a change during one asks for one more (a
      // joined in-flight request may predate the new row).
      tailInFlight: false,
      tailAgain: false,
      snapshot: EMPTY_SNAPSHOT,
    };
    entries.set(workerId, e);
  }
  return e;
}

function publish(e) {
  e.snapshot = {
    events: e.events,
    eventsFor: e.loaded ? e.workerId : null,
    hasOlder: e.parked.length > 0 || e.serverMore,
    loadingOlder: e.loadingOlder,
  };
  for (const cb of e.subs) cb();
}

export function getSnapshot(workerId) {
  return entries.get(workerId)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribe(workerId, cb) {
  const e = entryOf(workerId);
  e.subs.add(cb);
  return () => { e.subs.delete(cb); };
}

function applyNewest(e, rows) {
  if (!e.loaded) {
    e.events = mergeEvents([], rows);
    e.serverMore = rows.length === PAGE_SIZE;
    e.loaded = true;
  } else {
    e.events = mergeEvents(e.events, rows);
    capWindow(e);
  }
  publish(e);
}

// Nothing older is held any more: what the core has is asked for again.
function dropParked(e) {
  if (e.parked.length > 0) e.serverMore = true;
  e.parked = [];
  e.fillGen++;
}

// The newest parked rows join the window: at most `rows` of them, and when
// `turns` is given no more than that many turns.
function unpark(e, rows, turns = Infinity) {
  let cut = Math.max(0, e.parked.length - rows);
  if (turns !== Infinity) {
    let seen = 0;
    for (let i = e.parked.length - 1; i >= cut; i--) {
      if (PROMPT_TYPES.has(e.parked[i].type) && ++seen === turns) cut = i;
    }
  }
  const taken = e.parked.slice(cut);
  const last = taken[taken.length - 1];
  const first = e.events[0];
  // Parked rows are older than the window: they go in front of it as they are.
  // A row logged out of step with its time is the rare case that needs the sort.
  const inOrder = !last || !first || last.ts < first.ts || (last.ts === first.ts && last.id < first.id);
  e.events = inOrder ? taken.concat(e.events) : mergeEvents(e.events, taken);
  e.parked = e.parked.slice(0, cut);
  if (e.following) e.keep = e.events.length;
}

// One older page before `cursor`, with the limit it was asked at (a full page
// means there is more).
async function fetchOlderPage(e, cursor) {
  const limit = olderPageSize();
  const rows = await api.getWorkerEvents(e.workerId, { limit, order: "desc", beforeId: cursor });
  if (!Array.isArray(rows)) return null;
  const own = filterOwnRows(e.workerId, rows);
  // Parsed here, a page at a time: left to the commit that shows the history,
  // every payload of the chat would be parsed in that one frame.
  for (const row of own) rowPayload(row);
  return { rows: own, limit };
}

async function fetchNewest(e, signal) {
  try {
    const rows = await api.getWorkerEvents(e.workerId, { limit: PAGE_SIZE, order: "desc", signal });
    if (!Array.isArray(rows)) {
      // A non-array body is an error, not a no-op: keeping the window would
      // leave possibly-wrong rows renderable until a poll finally succeeds.
      e.events = [];
      e.parked = [];
      e.serverMore = false;
      e.fillGen++;
      e.loaded = false;
      publish(e);
      return;
    }
    const own = filterOwnRows(e.workerId, rows);
    applyNewest(e, own);
    for (const cb of e.newestListeners) cb(e.workerId, own);
    scheduleFill(e);
  } catch {
    // Abort or network blip — keep the cached window (stale beats empty).
  }
}

// The reader is in history and has not been given EAGER_HISTORY_ROWS yet. A
// view of another Mac pages instead: its rows cross a relay.
const readsEagerly = (e) =>
  !e.following && !isRemoteView() && e.events.length < EAGER_HISTORY_ROWS;

// Whether to read another older page: while less than a page is parked, and
// page after page while the reader is given history eagerly. A waiting
// loadOlder always gets its page.
function wantsFill(e) {
  if (e.attachers === 0 || !e.loaded || !e.serverMore) return false;
  return e.loadingOlder || readsEagerly(e) || e.parked.length < olderPageSize();
}

const nextFrame = typeof requestAnimationFrame === "function"
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);

// The reader is given history eagerly: what is parked joins the window a step
// per frame, so no single commit renders a whole page.
function drain(e) {
  if (e.draining) return;
  const step = () => {
    e.draining = readsEagerly(e) && e.parked.length > 0 && e.attachers > 0;
    if (!e.draining) return;
    unpark(e, OLDER_STEP, OLDER_STEP_TURNS);
    publish(e);
    nextFrame(step);
  };
  step();
}

function scheduleFill(e) {
  if (e.filling || e.fillScheduled || !wantsFill(e)) return;
  e.fillScheduled = true;
  idle(() => { e.fillScheduled = false; void fill(e); });
}

const stepTurns = (rows) => (rows === Infinity ? Infinity : OLDER_STEP_TURNS);

// Whether what is parked reaches as far back as the waiting loadOlder asked.
const reachedWanted = (e) =>
  e.wantUntilTs == null || !e.serverMore || (e.parked[0]?.ts ?? Infinity) <= e.wantUntilTs;

// Reads older pages, one request after another, while wantsFill holds. A page
// goes to the loadOlder waiting for it, into the window of a reader who is in
// history, and is parked otherwise.
async function fill(e) {
  if (e.filling) return;
  e.filling = true;
  try {
    while (wantsFill(e)) {
      const gen = e.fillGen;
      const cursor = (e.parked[0] ?? e.events[0])?.id;
      if (cursor == null) break;
      let page = null;
      try {
        page = await fetchOlderPage(e, cursor);
      } catch {
        // transient; retried below
      }
      if (gen !== e.fillGen) continue;
      if (!page) {
        // The view asks again once loadingOlder falls; a background read waits
        // for the next thing that schedules one.
        await new Promise((resolve) => setTimeout(resolve, OLDER_RETRY_MS));
        break;
      }
      e.parked = mergeEvents(page.rows, e.parked);
      e.serverMore = page.rows.length === page.limit;
      if (e.loadingOlder) {
        if (!reachedWanted(e)) continue;
        unpark(e, e.wantRows, stepTurns(e.wantRows));
        e.loadingOlder = false;
        publish(e);
      } else if (readsEagerly(e)) {
        drain(e);
        if (!e.serverMore && e.parked.length === 0) publish(e);
      } else if (!e.serverMore && e.parked.length === 0) {
        publish(e);
      }
    }
  } finally {
    e.filling = false;
    if (e.loadingOlder) {
      e.loadingOlder = false;
      publish(e);
    }
  }
}

// Moves older rows into the window: at once when they are parked, else as soon
// as the next page lands (loadingOlder meanwhile). By default one step;
// `rows: Infinity` takes everything held (a jump to a row further back).
// `untilTs` reads back to that row time first and shows it all in one go: a
// jump far into history costs one render, not one per page.
export function loadOlder(workerId, rows = OLDER_STEP, untilTs = null) {
  const e = entries.get(workerId);
  if (!e || !e.loaded || e.loadingOlder) return;
  e.wantUntilTs = untilTs;
  if (e.parked.length > 0 && reachedWanted(e)) {
    unpark(e, rows, stepTurns(rows));
    publish(e);
    // A reader paging through history gets the next page read at once; a view
    // filling its screen at the tail can wait for an idle moment.
    if (e.following) scheduleFill(e);
    else void fill(e);
    return;
  }
  if (e.events.length === 0 || (!e.serverMore && e.parked.length === 0)) return;
  e.wantRows = rows;
  e.loadingOlder = true;
  publish(e);
  void fill(e);
}

// Fetch only the rows appended after the highest loaded id and merge them in.
// Shared by the SSE delta fast path and the recurring poll — both want the tail
// only, never the whole newest page (which balloons once thinking rows
// accumulate). Best-effort: a transient failure is healed by the next poll's
// own afterId fetch. A non-array/empty body is a no-op here (stale beats empty);
// the leak-guard blanking lives in the full-page fetchNewest (attach/restart).
async function fetchAfter(e, signal) {
  let maxId = 0;
  for (const ev of e.events) if (ev.id > maxId) maxId = ev.id;
  try {
    const rows = await api.getWorkerEvents(e.workerId, { afterId: maxId, limit: PAGE_SIZE, signal });
    if (!Array.isArray(rows) || rows.length === 0) return;
    const own = filterOwnRows(e.workerId, rows);
    e.events = mergeEvents(e.events, own);
    capWindow(e);
    publish(e);
    for (const cb of e.newestListeners) cb(e.workerId, own);
  } catch {
    // abort or transient; the next poll heals
  }
}

// SSE fast path: pull only the rows appended after the highest loaded id.
// Falls back to the full newest-page fetch until a first page exists. No abort
// signal on purpose: the api client's in-flight dedup coalesces SSE bursts.
export function fetchDelta(workerId) {
  const e = entries.get(workerId);
  if (!e || !e.loaded || e.events.length === 0) {
    refetchNewest(workerId);
    return;
  }
  void fetchTail(e);
}

async function fetchTail(e) {
  if (e.tailInFlight) { e.tailAgain = true; return; }
  e.tailInFlight = true;
  try {
    do {
      e.tailAgain = false;
      await fetchAfter(e, undefined);
    } while (e.tailAgain && e.attachers > 0);
  } finally {
    e.tailInFlight = false;
  }
}

// The stream lost events it could not replay: every shown transcript pulls its tail.
export function refreshAttached() {
  for (const e of entries.values()) if (e.attachers > 0) fetchDelta(e.workerId);
}

// A change event for this worker (its rows grew): pull the tail while a pane shows it.
export function notifyWorkerChanged(workerId) {
  const e = entries.get(workerId);
  if (!e || e.attachers === 0 || e.changeTimer) return;
  e.changeTimer = setTimeout(() => { e.changeTimer = null; fetchDelta(workerId); }, CHANGE_DEBOUNCE_MS);
}

export function refetchNewest(workerId) {
  const e = entries.get(workerId);
  if (!e || e.attachers === 0) return;
  void fetchNewest(e, e.pollAbort?.signal);
}

// The newest FULL page is fetched once as the attach baseline — only when no
// window is cached: a cached one (switching back) just pulls its tail.
// Re-fetching it every 5s re-downloaded the entire window (tens of MB once a
// session accumulates thinking rows, each re-read/sanitized/serialized daemon
// side). The recurring tick pulls only the tail via afterId — see pollNewer —
// and only while the stream is down.
function startPoll(e) {
  stopPoll(e);
  e.pollAbort = new AbortController();
  if (e.primed && bootActive()) {
    // The window is the boot snapshot's and the stream resumes from where it was read.
    for (const cb of e.newestListeners) cb(e.workerId, e.events);
    scheduleFill(e);
  } else if (e.loaded && e.events.length > 0) {
    void fetchAfter(e, e.pollAbort.signal);
    scheduleFill(e);
  } else void fetchNewest(e, e.pollAbort.signal);
  e.primed = false;
  e.pollStop = startPolling(() => { if (!isStreamLive()) pollNewer(e); }, POLL_MS);
}

// Recurring poll tick. Incremental (afterId) once a baseline window exists;
// falls back to a full newest page only if the baseline never established
// (initial fetch failed, or the leak guard blanked the window).
function pollNewer(e) {
  const signal = e.pollAbort?.signal;
  if (!e.loaded || e.events.length === 0) {
    void fetchNewest(e, signal);
    return;
  }
  void fetchAfter(e, signal);
}

function stopPoll(e) {
  e.pollStop?.();
  e.pollStop = null;
  e.pollAbort?.abort();
  e.pollAbort = null;
  clearTimeout(e.changeTimer);
  e.changeTimer = null;
}

// Live-window bound (attached panes), while the view follows the tail: the
// oldest rows past the cap move to `parked`, which itself keeps one page, so
// loadOlder brings them back without a request.
function capWindow(e) {
  if (!e.following) return;
  const over = e.events.length - Math.max(MAX_ATTACHED_EVENTS, e.keep);
  if (over > 0) {
    e.parked = e.parked.concat(e.events.slice(0, over));
    e.events = e.events.slice(over);
  }
  const spare = e.parked.length - olderPageSize();
  if (spare > 0) {
    e.parked = e.parked.slice(spare);
    e.serverMore = true;
    e.fillGen++;
  }
}

// Detached windows are kept but bounded: trim to the newest rows (the part a
// switch-back renders first); deeper history re-pages on demand, and a trim
// re-opens the cursor. Parked rows are dropped — the read-ahead re-arms on the
// next attach.
function trimDetached(e) {
  dropParked(e);
  e.keep = 0;
  if (e.events.length > MAX_DETACHED_EVENTS) {
    e.events = e.events.slice(e.events.length - MAX_DETACHED_EVENTS);
    e.serverMore = true;
    publish(e);
  }
}

function evictDetached() {
  const detached = [...entries.values()].filter((e) => e.attachers === 0 && e.subs.size === 0);
  for (let i = 0; i <= detached.length - 1 - MAX_CACHED_WORKERS; i++) {
    const { workerId } = detached[i];
    entries.delete(workerId); // Map order = recency; oldest first
  }
}

// The view reports whether it is following the tail (pinned to bottom). While
// following, the live window is trimmed (capWindow); when the user scrolls up
// to read history we stop trimming so loadOlder's prepends aren't undone, and
// read the rest of the history ahead. Returning to the bottom re-caps right
// away.
export function setFollowing(workerId, following) {
  const e = entries.get(workerId);
  if (!e || e.following === following) return;
  e.following = following;
  if (following) {
    e.keep = 0;
    capWindow(e);
    publish(e);
  } else {
    drain(e);
    scheduleFill(e);
  }
}

// Start-up: the chat on screen takes its newest page from the boot snapshot before
// the first render, so its transcript draws in the first pass. Attached while the
// snapshot still stands, it then needs no request of its own.
export async function primeNewest(workerId) {
  const e = entryOf(workerId);
  if (e.loaded) return;
  await fetchNewest(e, undefined);
  e.primed = e.loaded;
}

// Lifecycle: polling and read-ahead run only while at least one component is
// attached. The last detach stops the poll and trims the cached window.
export function attach(workerId, { onNewest } = {}) {
  const e = entryOf(workerId);
  entries.delete(workerId); // LRU touch
  entries.set(workerId, e);
  if (onNewest) e.newestListeners.add(onNewest);
  e.attachers++;
  startPoll(e);
  evictDetached();
  return () => {
    if (onNewest) e.newestListeners.delete(onNewest);
    e.attachers = Math.max(0, e.attachers - 1);
    if (e.attachers === 0) {
      stopPoll(e);
      trimDetached(e);
    }
  };
}
