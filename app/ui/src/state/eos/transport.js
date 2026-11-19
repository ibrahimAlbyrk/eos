// Every Eos store reads and writes through this transport, so the sample gallery
// and tests can answer from JSON instead of the core. Both calls answer the
// client's envelope { ok, status, body }: a store tells a route the core does not
// serve (404) from a refusal or a failure by its status.

import { useSyncExternalStore } from "react";
import { api } from "../../api/client.js";

const coreTransport = {
  get: (path) => api.eosGet(path),
  send: (method, path, body) => api.eosSend(method, path, body),
};

let current = coreTransport;

// A dev run turns away what would start work or leave the Mac (403, "refused in
// a dev run: …"): screens say so in words instead of reporting a failure.
export function isDevRunRefusal(r) {
  return r?.status === 403 && typeof r.body?.error === "string" && r.body.error.startsWith("refused in a dev run");
}

// Once any write was refused that way, the sidebar says this is a dev run.
let devRunSeen = false;
const devRunSubs = new Set();

function noted(r) {
  if (!devRunSeen && isDevRunRefusal(r)) {
    devRunSeen = true;
    for (const cb of devRunSubs) cb();
  }
  return r;
}

function subscribeDevRun(cb) {
  devRunSubs.add(cb);
  return () => devRunSubs.delete(cb);
}

const devRunSnapshot = () => devRunSeen;

export function useDevRunSeen() {
  return useSyncExternalStore(subscribeDevRun, devRunSnapshot, devRunSnapshot);
}

export const transport = {
  get: (path) => current.get(path),
  send: (method, path, body) => current.send(method, path, body).then(noted),
};

// The gallery and tests swap the transport; null puts the core back.
export function setEosTransport(next) {
  current = next ?? coreTransport;
  devRunSeen = false;
}

// Answers reads from `reads` (path → JSON body); a path without a sample answers
// as the core does for a route it does not have. Every write is refused, so
// nothing drawn from samples can start or send anything.
export function fixtureTransport(reads) {
  return {
    get: async (path) => (Object.hasOwn(reads, path)
      ? { ok: true, status: 200, body: reads[path] }
      : { ok: false, status: 404, body: { error: "not found", path } }),
    send: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
  };
}
