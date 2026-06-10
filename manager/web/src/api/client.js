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

async function postJson(path, body, extraHeaders) {
  const r = await fetch(`${DAEMON}${path}`, {
    method: "POST",
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, body: parsed };
}

// Per-boot UI-origin token, injected by the native app shell (WKUserScript).
// Required on checkout-mutating endpoints so agents holding the daemon URL
// cannot self-apply.
function uiTokenHeader() {
  return typeof window !== "undefined" && window.__EOS_UI_TOKEN
    ? { "x-eos-ui-token": window.__EOS_UI_TOKEN }
    : {};
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
  async getWorkerEvents(id, { since = 0, order = "asc", limit, beforeId, signal } = {}) {
    const params = new URLSearchParams();
    params.set("since", String(since));
    params.set("order", order);
    if (limit != null) params.set("limit", String(limit));
    if (beforeId != null) params.set("beforeId", String(beforeId));
    const r = await getJson(`${ROUTES.workerEvents(id)}?${params.toString()}`, { signal });
    if (!r.ok) throw new Error(`getWorkerEvents → ${r.status}`);
    return r.body;
  },
  async sendWorkerMessage(id, text) {
    return postJson(ROUTES.workerMessage(id), { text });
  },
  async sendWorkerAction(id, action) {
    return postJson(ROUTES.workerAction(id), { action });
  },
  async pushWorker(id) {
    return postJson(ROUTES.workerPush(id));
  },
  async interruptWorker(id) {
    return postJson(ROUTES.workerInterrupt(id));
  },
  async resumeWorker(id) {
    return postJson(ROUTES.workerResume(id));
  },
  async sendKeystroke(id, keys) {
    return postJson(ROUTES.workerKeystroke(id), { keys });
  },
  async answerQuestion(id, toolUseId, answers, selections) {
    return postJson(ROUTES.workerQuestionAnswer(id), { toolUseId, answers, selections });
  },
  async getRewindTargets(id) {
    return getJson(ROUTES.workerRewindTargets(id));
  },
  async rewindWorker(id, uuid, mode = "conversation") {
    return postJson(ROUTES.workerRewind(id), { uuid, mode });
  },

  // Orchestrators
  async spawnOrchestrator({ name, cwd, model, effort, prompt, permissionMode } = {}) {
    return postJson(ROUTES.orchestrators, { name, cwd, model, effort, prompt, permissionMode });
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
  async uploadPaste(file) {
    const buf = await file.arrayBuffer();
    const r = await fetch(`${DAEMON}${ROUTES.fsPaste}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": file.name || "paste.png",
      },
      body: buf,
    });
    let parsed = null;
    try { parsed = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body: parsed };
  },
  async getDefaultApp(path) {
    const r = await fetch(`${DAEMON}${ROUTES.fsDefaultApp}?path=${encodeURIComponent(path)}`);
    return r.ok ? r.json() : { app: null };
  },
  async openFile(path) {
    return postJson(ROUTES.fsOpen, { path });
  },
  async listBranches(cwd) {
    const r = await fetch(`${DAEMON}${ROUTES.fsBranches}?cwd=${encodeURIComponent(cwd)}`);
    return r.ok
      ? r.json()
      : { branches: [], current: null, isGit: false, remoteUrl: null, ahead: null, behind: null, stash: 0, conflicts: 0 };
  },
  async checkout(cwd, branch) {
    return postJson(ROUTES.fsCheckout, { cwd, branch });
  },
  async getUnpushedCommits(cwd) {
    try {
      const r = await getJson(`${ROUTES.fsUnpushed}?cwd=${encodeURIComponent(cwd)}`);
      return r.ok ? r.body : { commits: [] };
    } catch {
      return { commits: [] };
    }
  },
  async getCommitDetail(cwd, sha) {
    const r = await getJson(`${ROUTES.fsCommit}?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}`);
    if (!r.ok) throw new Error(r.body?.error ?? `commit → ${r.status}`);
    return r.body;
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
  async setWorkerPermission(id, mode, { cascade } = {}) {
    return putJson(ROUTES.workerPermission(id), { mode, cascade });
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

  // Prompt templates
  async listTemplates() {
    const r = await getJson(ROUTES.templates);
    if (!r.ok) throw new Error(`listTemplates → ${r.status}`);
    return r.body;
  },
  async createTemplate({ name, description, content }) {
    return postJson(ROUTES.templates, { name, description, content });
  },
  async updateTemplate(name, { description, content }) {
    return putJson(ROUTES.template(name), { description, content });
  },
  async deleteTemplate(name) {
    return del(ROUTES.template(name));
  },

  // User settings — flat key→value map persisted daemon-side (localStorage
  // is wiped on every Eos.app launch, so it can't hold durable settings).
  async getSettings() {
    const r = await getJson(ROUTES.settings);
    if (!r.ok) throw new Error(`getSettings → ${r.status}`);
    return r.body?.settings ?? {};
  },
  async patchSettings(patch) {
    return putJson(ROUTES.settings, { settings: patch });
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

  async getPushState(id, { signal } = {}) {
    const fallback = {
      branch: null, remote: null, hasUpstream: false,
      ahead: 0, behind: 0, kind: "blocked", pushable: false, hasUncommitted: false,
    };
    try {
      const r = await getJson(ROUTES.workerPushState(id), { signal });
      return r.ok ? r.body : fallback;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      return fallback;
    }
  },

  async getWorkerChanges(id) {
    try {
      const r = await getJson(ROUTES.workerChanges(id));
      return r.ok ? r.body : { files: [], insertions: 0, deletions: 0 };
    } catch {
      return { files: [], insertions: 0, deletions: 0 };
    }
  },

  async getWorkerFileDiff(id, path, oldPath) {
    const params = new URLSearchParams({ path });
    if (oldPath) params.set("oldPath", oldPath);
    const r = await getJson(`${ROUTES.workerFileDiff(id)}?${params}`);
    if (!r.ok) throw new Error(`fileDiff → ${r.status}`);
    return r.body;
  },

  // Terminal (composer `!` mode) — UI-token gated like the try routes so
  // agents holding the daemon URL get no policy-free exec path. The worker
  // variant persists a durable event; the workspace variant (no agent
  // selected) is ephemeral.
  async runTerminal(id, command) {
    return postJson(ROUTES.workerTerminal(id), { command }, uiTokenHeader());
  },
  async runWorkspaceTerminal(cwd, command) {
    return postJson(ROUTES.terminal, { cwd, command }, uiTokenHeader());
  },
  async killTerminal(runId) {
    return postJson(ROUTES.terminalKill(runId), {}, uiTokenHeader());
  },

  // Try (unstaged apply) — state is a read; apply/keep/discard mutate the
  // user's checkout and carry the UI token.
  async getTryState(id) {
    try {
      const r = await getJson(ROUTES.workerTryState(id));
      return r.ok ? r.body : { activeTry: null, kept: false };
    } catch {
      return { activeTry: null, kept: false };
    }
  },
  async tryApply(id) {
    return postJson(ROUTES.workerTry(id), {}, uiTokenHeader());
  },
  async tryKeep(id) {
    return postJson(ROUTES.workerTryKeep(id), {}, uiTokenHeader());
  },
  async tryDiscard(id) {
    return postJson(ROUTES.workerTryDiscard(id), {}, uiTokenHeader());
  },

  // SSE — returns the EventSource so the caller can attach listeners. The
  // reconnect logic in store/sse.js wraps this.
  newEventStream() {
    return new EventSource(`${DAEMON}${ROUTES.stream}`);
  },
};
