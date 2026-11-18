// Every Eos store reads and writes through this transport, so the sample gallery
// and tests can answer from JSON instead of the core. Both calls answer the
// client's envelope { ok, status, body }: a store tells a route the core does not
// serve (404) from a refusal or a failure by its status.

import { api } from "../../api/client.js";

const coreTransport = {
  get: (path) => api.eosGet(path),
  send: (method, path, body) => api.eosSend(method, path, body),
};

let current = coreTransport;

export const transport = {
  get: (path) => current.get(path),
  send: (method, path, body) => current.send(method, path, body),
};

// The gallery and tests swap the transport; null puts the core back.
export function setEosTransport(next) {
  current = next ?? coreTransport;
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
