// Typed-ish daemon HTTP client. Components and the data layer call methods
// here instead of raw `fetch(...)`. Two benefits:
//   1. Single place to add headers / retry / auth in the future.
//   2. Route URLs live in one constants module (routes.js) so renaming an
//      endpoint is one edit, not a grep-and-pray sweep.

import { ROUTES } from "./routes.js";

const DAEMON = typeof location !== "undefined" ? location.origin : "";
// Raw-content origin (daemon.rawPort). Separate origin by design — runnable
// HTML is sandboxed with allow-same-origin there; see manager/routes/fs-raw.ts.
// The port mirrors the config default the same way the app shell hardcodes 7400.
const RAW_ORIGIN = (() => {
  try {
    const u = new URL(DAEMON || "http://127.0.0.1:7400");
    u.port = "7401";
    return u.origin;
  } catch {
    return "http://127.0.0.1:7401";
  }
})();
const JSON_HEADERS = { "content-type": "application/json" };

// Path-style URL (segments encoded, slashes literal) so relative subresources
// of served HTML resolve against the file's directory.
function encodeRawPath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

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

async function del(path, extraHeaders) {
  const r = await fetch(`${DAEMON}${path}`, { method: "DELETE", headers: extraHeaders });
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
  async getWorkerEvents(id, { since = 0, order = "asc", limit, beforeId, afterId, signal } = {}) {
    const params = new URLSearchParams();
    params.set("since", String(since));
    params.set("order", order);
    if (limit != null) params.set("limit", String(limit));
    if (beforeId != null) params.set("beforeId", String(beforeId));
    if (afterId != null) params.set("afterId", String(afterId));
    const r = await getJson(`${ROUTES.workerEvents(id)}?${params.toString()}`, { signal });
    if (!r.ok) throw new Error(`getWorkerEvents → ${r.status}`);
    return r.body;
  },
  async sendWorkerMessage(id, text, { clientMsgId, queueWhenBusy } = {}) {
    return postJson(ROUTES.workerMessage(id), { text, clientMsgId, queueWhenBusy });
  },
  // Daemon-side message queue — pills render from this; dismiss removes a
  // still-pending row.
  async getWorkerQueue(id) {
    try {
      const r = await getJson(ROUTES.workerQueue(id));
      return r.ok ? (r.body ?? { messages: [] }) : { messages: [] };
    } catch {
      return { messages: [] };
    }
  },
  async dismissQueuedMessage(id, queueId) {
    return del(ROUTES.workerQueueItem(id, queueId));
  },
  async sendWorkerAction(id, action) {
    return postJson(ROUTES.workerAction(id), { action });
  },
  async pushWorker(id) {
    return postJson(ROUTES.workerPush(id));
  },
  // Deterministic pull (fast-forward only) — gated like other working-tree
  // mutations. Returns the postJson envelope; caller reads `.body` (PullResult).
  async pullWorker(id) {
    return postJson(ROUTES.workerPull(id), {}, uiTokenHeader());
  },
  async interruptWorker(id) {
    return postJson(ROUTES.workerInterrupt(id));
  },
  async sendKeystroke(id, keys) {
    return postJson(ROUTES.workerKeystroke(id), { keys });
  },
  async answerQuestion(id, toolUseId, answers, dismissed = false) {
    return postJson(ROUTES.workerQuestionAnswer(id), {
      toolUseId,
      answers,
      ...(dismissed ? { dismissed: true } : {}),
    });
  },
  async getRewindTargets(id) {
    return getJson(ROUTES.workerRewindTargets(id));
  },

  // Project memory (Claude's file-based memory for the worker's project).
  // listMemory throws on error + returns { dir, entries }; create/delete return
  // the fetch envelope (caller reads .ok / .body.error). Mutations carry the
  // UI token — agents must not silently rewrite the user's accumulated memory.
  async listMemory(id) {
    const r = await getJson(ROUTES.workerMemory(id));
    if (!r.ok) throw new Error(r.body?.error || `listMemory → ${r.status}`);
    return r.body;
  },
  async deleteMemory(id, name) {
    return del(ROUTES.workerMemoryItem(id, name), uiTokenHeader());
  },
  async rewindWorker(id, uuid, mode = "conversation") {
    return postJson(ROUTES.workerRewind(id), { uuid, mode });
  },

  // Orchestrators
  async spawnOrchestrator({ name, cwd, model, effort, prompt, permissionMode } = {}) {
    return postJson(ROUTES.orchestrators, { name, cwd, model, effort, prompt, permissionMode });
  },
  async sendOrchestratorMessage(id, text, { clientMsgId, queueWhenBusy } = {}) {
    return postJson(ROUTES.orchestratorMessage(id), { text, clientMsgId, queueWhenBusy });
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
  rawUrl(path) { return `${RAW_ORIGIN}${ROUTES.fsRaw}${encodeRawPath(path)}`; },
  pdfViewerUrl(path) {
    const file = encodeURIComponent(`${ROUTES.fsRaw}${encodeRawPath(path)}`);
    return `${RAW_ORIGIN}${ROUTES.pdfjs}/web/viewer.html?file=${file}`;
  },
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
  async listBranches(cwd, { remotes = false } = {}) {
    const q = `?cwd=${encodeURIComponent(cwd)}${remotes ? "&remotes=1" : ""}`;
    const r = await fetch(`${DAEMON}${ROUTES.fsBranches}${q}`);
    return r.ok
      ? r.json()
      : { branches: [], current: null, isGit: false, remoteUrl: null, ahead: null, behind: null, stash: 0, conflicts: 0 };
  },
  // Branch admin + remote sync — all mutate the user's repo, so they carry the
  // UI token (checkout now does too, since the daemon gates it). Each returns
  // the postJson envelope; callers read `.body` for the { ok, error, ... } result.
  async checkout(cwd, branch, { stash = false } = {}) {
    return postJson(ROUTES.fsCheckout, { cwd, branch, stash }, uiTokenHeader());
  },
  async createBranch(cwd, name, { startPoint, checkout = true } = {}) {
    return postJson(ROUTES.fsBranchCreate, { cwd, name, startPoint, checkout }, uiTokenHeader());
  },
  async renameBranch(cwd, from, to) {
    return postJson(ROUTES.fsBranchRename, { cwd, from, to }, uiTokenHeader());
  },
  async deleteBranch(cwd, name, { force = false } = {}) {
    return postJson(ROUTES.fsBranchDelete, { cwd, name, force }, uiTokenHeader());
  },
  async deleteRemoteBranch(cwd, remote, branch) {
    return postJson(ROUTES.fsRemoteBranchDelete, { cwd, remote, branch }, uiTokenHeader());
  },
  async fetchRemote(cwd, { prune = true } = {}) {
    return postJson(ROUTES.fsFetch, { cwd, prune }, uiTokenHeader());
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
  // Breadcrumb "Open in" — UI-token gated like the terminal routes.
  async openWorkerIn(id, target) {
    return postJson(ROUTES.workerOpen(id), { target }, uiTokenHeader());
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
      pullable: false, pullKind: "blocked",
    };
    try {
      const r = await getJson(ROUTES.workerPushState(id), { signal });
      return r.ok ? r.body : fallback;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      return fallback;
    }
  },

  async getWorkerChanges(id, { patches = false } = {}) {
    try {
      const r = await getJson(ROUTES.workerChanges(id) + (patches ? "?patches=1" : ""));
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

  // Merge-conflict resolution. List + per-file document are reads; resolve
  // writes a file + `git add`, so it carries the UI token like /try.
  async getWorkerConflicts(id) {
    try {
      const r = await getJson(ROUTES.workerConflicts(id));
      return r.ok ? r.body : { files: [] };
    } catch {
      return { files: [] };
    }
  },
  async getWorkerConflictFile(id, path) {
    const r = await getJson(`${ROUTES.workerConflictFile(id)}?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`conflictFile → ${r.status}`);
    return r.body;
  },
  async resolveWorkerConflict(id, body) {
    return postJson(ROUTES.workerConflictResolve(id), body, uiTokenHeader());
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
    const fallback = { activeTries: [], kept: false, syncable: false, syncFiles: [] };
    try {
      const r = await getJson(ROUTES.workerTryState(id));
      return r.ok ? r.body : fallback;
    } catch {
      return fallback;
    }
  },
  async tryApply(id) {
    return postJson(ROUTES.workerTry(id), {}, uiTokenHeader());
  },
  // Keep/Discard act on a specific stack layer: `id` resolves the repo,
  // `ownerId` is the layer's worker (may already be deleted).
  async tryKeep(id, ownerId) {
    return postJson(ROUTES.workerTryKeep(id), { workerId: ownerId }, uiTokenHeader());
  },
  async tryDiscard(id, ownerId) {
    return postJson(ROUTES.workerTryDiscard(id), { workerId: ownerId }, uiTokenHeader());
  },

  // SSE — returns the EventSource so the caller can attach listeners. The
  // reconnect logic in store/sse.js wraps this.
  newEventStream() {
    return new EventSource(`${DAEMON}${ROUTES.stream}`);
  },
};
