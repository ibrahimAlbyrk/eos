// Live terminal-run buffers (composer `!` mode). Ephemeral by design: chunks
// stream in over SSE while a command runs; the durable record is the single
// `terminal` event the daemon appends on completion. Messages renders live
// runs as overlay blocks and removes an entry once its durable event lands.

const runs = new Map(); // runId -> {workerId, command, output, done, exitCode, note, ts}
// Workspace runs dismissed by selecting an agent — late chunks of a just-killed
// run must not re-materialize the card. Forgotten once the run's own `done`
// lands (suppression only needs to outlive the in-flight stream); CLEARED_CAP
// trims the oldest as a backstop for runs that never report done, so the Set
// can't grow one UUID per dismissed run for the tab's lifetime.
const cleared = new Set();
const CLEARED_CAP = 200;
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function startRun(workerId, runId, command) {
  runs.set(runId, { workerId, command, output: "", done: false, exitCode: null, note: null, ts: Date.now() });
  emit();
}

export function applyChunk({ workerId, runId, command, data }) {
  if (!runId || cleared.has(runId)) return;
  let r = runs.get(runId);
  if (!r) {
    // Another client started this run — materialize it from the first chunk.
    r = { workerId, command: command ?? "", output: "", done: false, exitCode: null, note: null, ts: Date.now() };
    runs.set(runId, r);
  }
  r.output += data ?? "";
  emit();
}

export function applyDone({ runId, exitCode, note }) {
  cleared.delete(runId); // stream is over — no late chunk left to suppress
  const r = runs.get(runId);
  if (!r) return;
  r.done = true;
  r.exitCode = exitCode ?? 0;
  r.note = note ?? null;
  emit();
}

export function removeRun(runId) {
  if (runs.delete(runId)) emit();
}

// Selecting an agent dismisses the no-selection view's workspace cards for
// good. Returns the dropped runs so the caller can kill still-running ones.
export function clearWorkspaceRuns() {
  const dropped = [];
  for (const [runId, r] of runs) {
    if (r.workerId !== null) continue;
    dropped.push({ runId, done: r.done });
    runs.delete(runId);
    cleared.add(runId);
    if (cleared.size > CLEARED_CAP) cleared.delete(cleared.values().next().value);
  }
  if (dropped.length > 0) emit();
  return dropped;
}

// Drop a worker's live run buffers (its accumulated output strings). Workspace
// runs (workerId === null) are unaffected — they're dismissed via clearWorkspaceRuns.
export function purge(workerId) {
  let changed = false;
  for (const [runId, r] of [...runs]) {
    if (r.workerId === workerId) { runs.delete(runId); changed = true; }
  }
  if (changed) emit();
}

// Drop runs for workers no longer in the live list — auto-shutdown / cascade
// death leaves a still-running worker-scoped run holding its full output string.
export function pruneExcept(presentIds) {
  const dead = new Set();
  for (const r of runs.values()) {
    if (r.workerId !== null && !presentIds.has(r.workerId)) dead.add(r.workerId);
  }
  for (const id of dead) purge(id);
}

export function liveRunsFor(workerId) {
  const out = [];
  for (const [runId, r] of runs) {
    if (r.workerId === workerId) out.push({ runId, ...r });
  }
  return out;
}
