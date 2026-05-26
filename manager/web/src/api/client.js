// Typed-ish daemon HTTP client. Components and the data layer call methods
// here instead of raw `fetch(...)`. Two benefits:
//   1. Single place to add headers / retry / auth in the future.
//   2. Route URLs live in one constants module (routes.js) so renaming an
//      endpoint is one edit, not a grep-and-pray sweep.

import { ROUTES } from "./routes.js";

const DAEMON = typeof location !== "undefined" ? location.origin : "";
const JSON_HEADERS = { "content-type": "application/json" };

const inflight = new Map();

function deduplicatedFetch(url, opts) {
  if (opts?.method && opts.method !== "GET") return fetch(url, opts);
  if (opts?.signal) return fetch(url, opts);
  const key = url;
  if (inflight.has(key)) return inflight.get(key);
  const p = fetch(url, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function getJson(path, { signal } = {}) {
  const url = `${DAEMON}${path}`;
  const r = signal ? await fetch(url, { signal }) : await deduplicatedFetch(url);
  let parsed = null;
  try { parsed = await r.json(); } catch {}
  if (!r.ok) return { ok: false, status: r.status, body: parsed };
  return { ok: true, status: r.status, body: parsed };
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
  async health() {
    const r = await getJson(ROUTES.health);
    if (!r.ok) throw new Error(`health → ${r.status}`);
    return r.body;
  },
  async uiConfig() {
    const r = await fetch(`${DAEMON}${ROUTES.uiConfig}`);
    return r.ok ? r.json() : null;
  },

  // Workers
  async listWorkers() {
    const r = await getJson(ROUTES.workers);
    if (!r.ok) throw new Error(`listWorkers → ${r.status}`);
    return r.body;
  },
  async spawnWorker(spec) { return postJson(ROUTES.workers, spec); },
  async killWorker(id) { return del(ROUTES.worker(id)); },
  async getWorkerEvents(id, { since = 0, order = "asc", limit, signal } = {}) {
    const params = new URLSearchParams();
    params.set("since", String(since));
    params.set("order", order);
    if (limit != null) params.set("limit", String(limit));
    const r = await getJson(`${ROUTES.workerEvents(id)}?${params.toString()}`, { signal });
    if (!r.ok) throw new Error(`getWorkerEvents → ${r.status}`);
    return r.body;
  },
  async sendWorkerMessage(id, text) {
    return postJson(ROUTES.workerMessage(id), { text });
  },
  async interruptWorker(id) {
    return postJson(ROUTES.workerInterrupt(id));
  },

  // Orchestrators
  async spawnOrchestrator({ name, cwd, model, effort, prompt } = {}) {
    return postJson(ROUTES.orchestrators, { name, cwd, model, effort, prompt });
  },
  async sendOrchestratorMessage(id, text) {
    return postJson(ROUTES.orchestratorMessage(id), { text });
  },

  // Pending
  async listPending() {
    const r = await getJson(ROUTES.pending);
    if (!r.ok) throw new Error(`listPending → ${r.status}`);
    return r.body;
  },
  async approvePending(id, updatedInput) {
    const body = { decision: "allow" };
    if (updatedInput) body.updatedInput = updatedInput;
    return postJson(ROUTES.pendingDecision(id), body);
  },
  async denyPending(id, reason) {
    return postJson(ROUTES.pendingDecision(id), { decision: "deny", reason: reason || "denied via web UI" });
  },
  async addPolicyRule(tool, behavior) {
    return postJson(ROUTES.policyRule, { tool, behavior });
  },

  // Session
  async getSession() {
    try {
      const r = await getJson(ROUTES.session);
      return r.ok ? r.body : null;
    } catch { return null; }
  },

  // FS helpers
  async pickDirectory() {
    const r = await getJson(ROUTES.pickDirectory);
    if (!r.ok) throw new Error(`pickDirectory → ${r.status}`);
    return r.body;
  },
  async pickFiles() {
    const r = await getJson(ROUTES.pickFile);
    if (!r.ok) throw new Error(`pickFiles → ${r.status}`);
    return r.body;
  },
  imageUrl(path) { return `${DAEMON}${ROUTES.fsImage}?path=${encodeURIComponent(path)}`; },
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
    try {
      const r = await getJson(ROUTES.fsRecents);
      return r.ok ? r.body : { paths: [] };
    } catch { return { paths: [] }; }
  },
  async readFile(path) {
    const r = await getJson(`${ROUTES.fsRead}?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`readFile → ${r.status}`);
    return r.body;
  },
  async writeFile(path, content) {
    return postJson(ROUTES.fsWrite, { path, content });
  },
  async revealFile(path) {
    return postJson(ROUTES.fsReveal, { path });
  },

  // Per-agent settings
  async renameWorker(id, name) {
    return putJson(ROUTES.workerName(id), { name });
  },
  async setWorkerPermission(id, mode) {
    return putJson(ROUTES.workerPermission(id), { mode });
  },
  async setWorkerModel(id, model, effort) {
    return putJson(ROUTES.workerModel(id), { model, effort });
  },
  async listFiles(cwd, query = "") {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (query) params.set("query", query);
    const r = await getJson(`${ROUTES.fsList}?${params.toString()}`);
    if (!r.ok) throw new Error(`listFiles → ${r.status}`);
    return r.body;
  },

  async listCommands(cwd) {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const r = await getJson(`${ROUTES.commands}${params}`);
    if (!r.ok) throw new Error(`listCommands → ${r.status}`);
    return r.body;
  },

  async getWorkerDiff(id, { signal } = {}) {
    try {
      const r = await getJson(ROUTES.workerDiff(id), { signal });
      return r.ok ? r.body : { insertions: 0, deletions: 0, files: 0 };
    } catch (e) {
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
