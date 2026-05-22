// Typed-ish daemon HTTP client. Components and the data layer call methods
// here instead of raw `fetch(...)`. Two benefits:
//   1. Single place to add headers / retry / auth in the future.
//   2. Route URLs live in one constants module (routes.js) so renaming an
//      endpoint is one edit, not a grep-and-pray sweep.

import { ROUTES } from "./routes.js";

const DAEMON = typeof location !== "undefined" ? location.origin : "";
const JSON_HEADERS = { "content-type": "application/json" };

async function getJson(path) {
  const r = await fetch(`${DAEMON}${path}`);
  return r.json();
}

async function postJson(path, body) {
  const r = await fetch(`${DAEMON}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body: parsed };
}

async function del(path) {
  const r = await fetch(`${DAEMON}${path}`, { method: "DELETE" });
  let parsed = null;
  try { parsed = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body: parsed };
}

export const api = {
  daemon: DAEMON,
  routes: ROUTES,

  // Health + status
  async health() { return getJson(ROUTES.health); },
  async uiConfig() {
    const r = await fetch(`${DAEMON}${ROUTES.uiConfig}`);
    return r.ok ? r.json() : null;
  },

  // Workers
  async listWorkers() { return getJson(ROUTES.workers); },
  async spawnWorker(spec) { return postJson(ROUTES.workers, spec); },
  async killWorker(id) { return del(ROUTES.worker(id)); },
  async getWorkerEvents(id, { since = 0, order = "asc", limit } = {}) {
    const params = new URLSearchParams();
    params.set("since", String(since));
    params.set("order", order);
    if (limit != null) params.set("limit", String(limit));
    return getJson(`${ROUTES.workerEvents(id)}?${params.toString()}`);
  },
  async sendWorkerMessage(id, text) {
    return postJson(ROUTES.workerMessage(id), { text });
  },

  // Orchestrators
  async spawnOrchestrator({ name, cwd, model } = {}) {
    return postJson(ROUTES.orchestrators, { name, cwd, model });
  },
  async sendOrchestratorMessage(id, text) {
    return postJson(ROUTES.orchestratorMessage(id), { text });
  },

  // Pending
  async listPending() { return getJson(ROUTES.pending); },
  async approvePending(id, updatedInput) {
    const body = { decision: "allow" };
    if (updatedInput) body.updatedInput = updatedInput;
    return postJson(ROUTES.pendingDecision(id), body);
  },
  async denyPending(id, reason) {
    return postJson(ROUTES.pendingDecision(id), { decision: "deny", reason: reason || "denied via web UI" });
  },

  // Session
  async getSession() {
    try { return await getJson(ROUTES.session); }
    catch { return null; }
  },

  // FS helpers
  async pickDirectory() { return getJson(ROUTES.pickDirectory); },
  async getDefaultApp(path) {
    const r = await fetch(`${DAEMON}${ROUTES.fsDefaultApp}?path=${encodeURIComponent(path)}`);
    return r.ok ? r.json() : { app: null };
  },
  async openFile(path) {
    return postJson(ROUTES.fsOpen, { path });
  },

  // SSE — returns the EventSource so the caller can attach listeners. The
  // reconnect logic in store/sse.js wraps this.
  newEventStream() {
    return new EventSource(`${DAEMON}${ROUTES.stream}`);
  },
};
