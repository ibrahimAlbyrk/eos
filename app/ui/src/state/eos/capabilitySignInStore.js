// capabilitySignInStore — the sign-in sheet's one attempt (GitHub's device flow).
// Starting asks the core for a code and opens GitHub's page in the system
// browser; the store then asks the core how the attempt stands until it ends.
// The user code lives here and on the sheet only.
//
// attempt: null, or { id, phase, userCode?, verificationUri?, accountLabel?, error? }
// with phase starting → code → pending → ready | expired | denied | failed, or
// cancelled, client_id_missing, dev_run. A failed attempt carries the line the
// sheet shows as `error`.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { isDevRunRefusal, transport } from "./transport.js";

const POLL_MS = 2000;
const ENDS = { signed_in: "ready", expired: "expired", denied: "denied", failed: "failed" };
// The core ends an attempt as failed when GitHub did not answer in time, or refused.
const DID_NOT_WORK = "The sign-in did not work.";
const ACTIVE = new Set(["starting", "code", "pending"]);

let attempt = null;
let seq = 0; // bumped by every start, cancel and close: older answers are dropped
let timer = null;
const subs = new Set();

function set(next) {
  attempt = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => attempt;

export function useSignIn() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function stop() {
  seq += 1;
  clearTimeout(timer);
  timer = null;
}

// Opens GitHub's page in the system browser; only an https address is opened.
export function openSignInPage() {
  const uri = attempt?.verificationUri;
  if (typeof uri === "string" && uri.startsWith("https://")) window.open(uri, "_blank", "noopener,noreferrer");
}

function follow(n) {
  timer = setTimeout(() => void poll(n), POLL_MS);
}

async function poll(n) {
  const r = await transport.get(ROUTES.capabilitySignIn(attempt.id)).catch(() => null);
  if (n !== seq) return;
  // The core forgot the attempt (a restart); anything else not ok passes.
  if (r?.status === 404) return set({ ...attempt, phase: "failed", error: "The sign-in was interrupted. Try again." });
  const end = ENDS[r?.body?.state];
  if (r?.ok && end === "failed") return set({ ...attempt, phase: "failed", error: DID_NOT_WORK });
  if (r?.ok && end) return set({ ...attempt, phase: end, accountLabel: r.body.accountLabel });
  if (r?.ok && r.body?.state === "pending" && attempt.phase !== "pending") set({ ...attempt, phase: "pending" });
  follow(n);
}

export async function startSignIn(id) {
  stop();
  const n = seq;
  set({ id, phase: "starting" });
  const r = await transport.send("POST", ROUTES.capabilitySignIn(id)).catch(() => null);
  if (n !== seq) return;
  if (r?.ok && typeof r.body?.userCode === "string") {
    const { userCode, verificationUri } = r.body;
    set({ id, phase: "code", userCode, verificationUri });
    openSignInPage();
    follow(n);
  } else if (r?.status === 409 && r.body?.code === "client_id_missing") {
    set({ id, phase: "client_id_missing" });
  } else if (isDevRunRefusal(r)) {
    set({ id, phase: "dev_run" });
  } else {
    set({ id, phase: "failed", error: startFailure(r) });
  }
}

// Why a start gave no code. The core's own words for 502 and 429 name only the
// capability's id, so those two are said here.
function startFailure(r) {
  if (!r) return "Eos isn't reachable.";
  if (r.status === 502) return `${DID_NOT_WORK} GitHub did not give Eos a code.`;
  if (r.status === 429) return "GitHub is limiting requests. Try again in a few minutes.";
  return r.body?.error ?? "Eos could not start the sign-in.";
}

// Tells the core to stop waiting for the code.
export function cancelSignIn() {
  if (!ACTIVE.has(attempt?.phase)) return;
  stop();
  void transport.send("DELETE", ROUTES.capabilitySignIn(attempt.id)).catch(() => null);
  set({ id: attempt.id, phase: "cancelled" });
}

export function closeSignIn() {
  cancelSignIn();
  stop();
  set(null);
}
