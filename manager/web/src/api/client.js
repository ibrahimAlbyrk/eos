// Typed-ish daemon HTTP client. Components and the data layer call methods
// here instead of raw `fetch(...)`. Two benefits:
//   1. Single place to add headers / retry / auth in the future.
//   2. Route URLs live in one constants module (routes.js) so renaming an
//      endpoint is one edit, not a grep-and-pray sweep.

import { ROUTES } from "./routes.js";

const DAEMON = typeof location !== "undefined" ? location.origin : "";
const JSON_HEADERS = { "content-type": "application/json" };

async function getJson(path, { signal } = {}) {
  const r = await fetch(`${DAEMON}${path}`, { signal });
  // fetch doesn't throw on non-2xx; surface failures so callers can fall
  // back instead of parsing an error envelope as the success shape.
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
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

async function putJson(path, body) {
  const r = await fetch(`${DAEMON}${path}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
  });
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
  async getWorkerEvents(id, { since = 0, order = "asc", limit, signal } = {}) {
    const params = new URLSearchParams();
    params.set("since", String(since));
    params.set("order", order);
    if (limit != null) params.set("limit", String(limit));
    return getJson(`${ROUTES.workerEvents(id)}?${params.toString()}`, { signal });
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
  async listBranches(cwd) {
    const r = await fetch(`${DAEMON}${ROUTES.fsBranches}?cwd=${encodeURIComponent(cwd)}`);
    return r.ok ? r.json() : { branches: [], current: null, isGit: false };
  },
  async checkout(cwd, branch) {
    return postJson(ROUTES.fsCheckout, { cwd, branch });
  },
  async listRecents() {
    try { return await getJson(ROUTES.fsRecents); }
    catch { return { paths: [] }; }
  },
  async readFile(path) {
    return getJson(`${ROUTES.fsRead}?path=${encodeURIComponent(path)}`);
  },
  async writeFile(path, content) {
    return postJson(ROUTES.fsWrite, { path, content });
  },
  async revealFile(path) {
    return postJson(ROUTES.fsReveal, { path });
  },

  // Per-agent settings
  async setWorkerPermission(id, mode) {
    return putJson(ROUTES.workerPermission(id), { mode });
  },
  async setWorkerModel(id, model, effort) {
    return putJson(ROUTES.workerModel(id), { model, effort });
  },
  async listCommands(cwd) {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return getJson(`${ROUTES.commands}${params}`);
  },

  async getWorkerDiff(id, { signal } = {}) {
    try { return await getJson(ROUTES.workerDiff(id), { signal }); }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      return { insertions: 0, deletions: 0, files: 0 };
    }
  },

  // SSE — returns the EventSource so the caller can attach listeners. The
  // reconnect logic in store/sse.js wraps this.
  newEventStream() {
    return new EventSource(`${DAEMON}${ROUTES.stream}`);
  },
};
