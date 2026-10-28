// The /btw side question, per agent: one question at a time, answered from the
// agent's live conversation (POST /workers/:id/btw). It lives only in this
// window — nothing reaches the transcript or the daemon's state, so a reload
// forgets it. A new question replaces the previous one and cancels it if it is
// still being answered.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

// workerId -> { question, status: "asking" | "done" | "error", answer, error }
const entries = new Map();
// workerId -> the AbortController of the question still being answered
const pending = new Map();
const listeners = new Set();

function put(workerId, entry) {
  if (entry) entries.set(workerId, entry);
  else entries.delete(workerId);
  for (const l of listeners) l();
}

export function askSideQuestion(workerId, question) {
  const q = (question ?? "").trim();
  if (!workerId || !q) return;
  pending.get(workerId)?.abort();
  const ctrl = new AbortController();
  pending.set(workerId, ctrl);
  put(workerId, { question: q, status: "asking", answer: null, error: null });
  // A superseded or cancelled question no longer owns the entry.
  const settle = (patch) => {
    if (pending.get(workerId) !== ctrl) return;
    pending.delete(workerId);
    put(workerId, { question: q, answer: null, error: null, ...patch });
  };
  api.askSideQuestion(workerId, q, { signal: ctrl.signal }).then(
    (r) => settle(r.ok
      ? { status: "done", answer: r.body?.answer ?? "" }
      : { status: "error", error: r.body?.error ?? `side question failed (${r.status})` }),
    (e) => settle({ status: "error", error: e instanceof Error ? e.message : String(e) }),
  );
}

// Drop the agent's side question, cancelling it if it is still being answered.
export function clearSideQuestion(workerId) {
  const ctrl = pending.get(workerId);
  pending.delete(workerId);
  ctrl?.abort();
  if (entries.has(workerId)) put(workerId, null);
}

export function getSideQuestion(workerId) {
  return entries.get(workerId) ?? null;
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSideQuestion(workerId) {
  const get = () => (workerId ? getSideQuestion(workerId) : null);
  return useSyncExternalStore(subscribe, get, get);
}

// Agents that left the live list take their side question with them.
export function pruneExcept(present) {
  for (const id of [...entries.keys(), ...pending.keys()]) {
    if (!present.has(id)) clearSideQuestion(id);
  }
}

export function _reset() {
  for (const ctrl of pending.values()) ctrl.abort();
  entries.clear();
  pending.clear();
  listeners.clear();
}
