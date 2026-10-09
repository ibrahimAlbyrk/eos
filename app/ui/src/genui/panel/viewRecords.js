// Stored views by id (GET /api/genui/views/:id) for the side-panel tab, which
// must rebuild from its id alone after a reload. The inline view seeds its
// record when it opens the tab, so the panel shows at once without a fetch.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../../api/client.js";

export const MISSING = Symbol("missing view");

const records = new Map(); // viewId -> record | MISSING
const inflight = new Map(); // viewId -> Promise
const subs = new Set();
let version = 0;

function emit() {
  version++;
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getViewRecord(id) {
  return records.get(id) ?? null;
}

// record: { id, workerId, title, createdAt, kind: "view"|"app", spec }.
export function seedViewRecord(record) {
  if (!record?.id || records.get(record.id) === record) return;
  const cur = records.get(record.id);
  if (cur && cur !== MISSING && cur.workerId && !record.workerId) return;
  records.set(record.id, record);
  emit();
}

// A fetch that failed for any reason but 404 (the daemon restarting, a host's
// link down): retried with backoff, then left to the panel's Retry button.
const failures = new Map(); // viewId -> { reason, attempts, timer }
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const RETRY_ATTEMPTS = 8;

function noteFailure(id, e) {
  const f = failures.get(id) ?? { reason: "", attempts: 0, timer: 0 };
  f.reason = e instanceof Error ? e.message : String(e);
  f.attempts++;
  clearTimeout(f.timer);
  if (f.attempts < RETRY_ATTEMPTS) {
    f.timer = setTimeout(() => {
      if (failures.get(id) === f && !records.has(id)) void fetchViewRecord(id);
    }, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (f.attempts - 1)));
  }
  failures.set(id, f);
  emit();
}

function clearFailure(id) {
  const f = failures.get(id);
  if (!f) return;
  clearTimeout(f.timer);
  failures.delete(id);
}

export function fetchViewRecord(id) {
  if (!id) return Promise.resolve(null);
  if (inflight.has(id)) return inflight.get(id);
  const p = api.getGenuiView(id)
    .then((r) => {
      clearFailure(id);
      records.set(id, r ?? MISSING);
      emit();
      return r;
    })
    .catch((e) => {
      noteFailure(id, e);
      return null;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export function getViewRecordError(id) {
  return records.has(id) ? null : failures.get(id)?.reason ?? null;
}

// The panel's Retry: start the backoff over and fetch now.
export function retryViewRecord(id) {
  clearFailure(id);
  emit();
  return fetchViewRecord(id);
}

export function useViewRecordError(id) {
  const snap = useCallback(() => getViewRecordError(id), [id]);
  return useSyncExternalStore(subscribe, snap, snap);
}

export function useViewRecord(id) {
  const snap = useCallback(() => records.get(id) ?? null, [id]);
  const rec = useSyncExternalStore(subscribe, snap, snap);
  const known = rec !== null;
  useEffect(() => {
    if (id && !known) void fetchViewRecord(id);
  }, [id, known]);
  return rec;
}

// Re-render on any record change (tab labels are view titles).
export function useViewRecordsVersion() {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function viewTitleOf(id) {
  const r = records.get(id);
  return r && r !== MISSING ? r.title || r.spec?.title || null : null;
}

// Test-only.
export function _reset() {
  for (const f of failures.values()) clearTimeout(f.timer);
  failures.clear();
  records.clear();
  inflight.clear();
  subs.clear();
}
