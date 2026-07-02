// Typed-ish daemon HTTP client. Components and the data layer call methods
// here instead of raw `fetch(...)`. Two benefits:
//   1. Single place to add headers / retry / auth in the future.
//   2. Route URLs live in one constants module (routes.js) so renaming an
//      endpoint is one edit, not a grep-and-pray sweep.

import { ROUTES } from "./routes.js";

// The native app loads the UI from the eos://app/ origin, so the daemon URL
// can't be derived from location.origin; the app shell injects
// window.__EOS_DAEMON_URL. Falls back to the loopback port the shell assumes.
const DAEMON =
  (typeof window !== "undefined" && window.__EOS_DAEMON_URL) || "http://127.0.0.1:7400";
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

// Stable per-tab id. Sent on the /stream URL and on /fs/watch so the daemon
// ties this tab's directory watches to its SSE connection — a dropped tab
// releases them (FsWatchRegistry), even without an explicit unwatch.
const CLIENT_ID = (() => {
  try { return crypto.randomUUID(); } catch { return `c-${Math.random().toString(36).slice(2)}-${Date.now()}`; }
})();

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
  clientId: CLIENT_ID,

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
  // A configured provider's available models for the two-level composer picker.
  // Fail-soft: never throws — returns { models, error? } so the popover can fall
  // back to the profile's pinned model.
  async listBackendModels(name) {
    try {
      const r = await getJson(ROUTES.apiBackendModels(name));
      if (r.ok) return r.body ?? { models: [] };
      return { models: [], error: r.body?.error ?? `models → ${r.status}` };
    } catch (e) {
      return { models: [], error: e instanceof Error ? e.message : String(e) };
    }
  },
  // Built-in add-provider presets — the catalog to list in the provider-management UI.
  async listBackendPresets() {
    try {
      const r = await getJson(ROUTES.apiBackendPresets);
      return r.ok ? (r.body?.presets ?? []) : [];
    } catch {
      return [];
    }
  },
  // Ephemeral connection test — validates a provider config (preset + key) via a live
  // /v1/models call before the config is persisted.
  async testBackend(body) {
    return postJson(ROUTES.apiBackendTest, body);
  },
  // Add a provider profile (writes the key to Keychain + config.json, reloads daemon).
  async addBackend(body) {
    return postJson(ROUTES.apiBackends, body);
  },
  // Remove a configured provider profile by name.
  async deleteBackend(name) {
    return del(ROUTES.apiBackendDelete(name));
  },

  // Workers
  async listWorkers() {
    const r = await getJson(ROUTES.workers);
    if (!r.ok) throw new Error(`listWorkers → ${r.status}`);
    return r.body;
  },
  async spawnWorker(spec) { return postJson(ROUTES.workers, spec); },
  // Archive / restore / purge / kill — the dashboard's worker lifecycle ops.
  // Archive replaces the old hard delete on Cmd+W (reversible; rows/worktree
  // kept); purge permanently deletes an ARCHIVED worker, kill a LIVE one —
  // both confirm-gated in the menus that call them.
  async archiveWorker(id) { return postJson(ROUTES.workerArchive(id)); },
  async restoreWorker(id) { return postJson(ROUTES.workerRestore(id)); },
  async purgeWorker(id) { return del(ROUTES.workerPurge(id)); },
  async killWorker(id) { return del(ROUTES.worker(id)); },
  async listArchivedWorkers() {
    const r = await getJson(ROUTES.workersArchived);
    if (!r.ok) throw new Error(`listArchivedWorkers → ${r.status}`);
    return r.body;
  },
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
  async spawnOrchestrator({ name, cwd, model, effort, prompt, permissionMode, backendKind, backendProfile } = {}) {
    return postJson(ROUTES.orchestrators, { name, cwd, model, effort, prompt, permissionMode, backendKind, backendProfile });
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
  // `src` is a File/Blob, or a snapshot {name, bytes} whose bytes were read
  // synchronously inside the paste event — a WKWebView clipboard-backed File
  // goes empty once the clipboard changes, so the byte read can't be deferred
  // to here. `bytes` may be an ArrayBuffer or a Promise<ArrayBuffer>.
  async uploadPaste(src) {
    const buf = src.bytes !== undefined ? await src.bytes : await src.arrayBuffer();
    const r = await fetch(`${DAEMON}${ROUTES.fsPaste}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": src.name || "paste.png",
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
  // UI-token gated (the daemon now requires it). `root`/`mkdirp` sandbox + create
  // parents for the Files explorer; legacy callers pass neither.
  async writeFile(path, content, { root, mkdirp } = {}) {
    return postJson(ROUTES.fsWrite, { path, content, root, mkdirp }, uiTokenHeader());
  },
  async revealFile(path) {
    return postJson(ROUTES.fsReveal, { path });
  },

  // Files explorer — per-entry detail + mutations. Mutations carry the UI token
  // (an agent holding the daemon URL must not touch the user's files) and a
  // `root` the daemon sandboxes every path within.
  async statPath(path) {
    const r = await getJson(`${ROUTES.fsStat}?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`stat → ${r.status}`);
    return r.body;
  },
  async createEntry(root, path, type, content) {
    return postJson(ROUTES.fsCreate, { root, path, type, content }, uiTokenHeader());
  },
  async renameEntry(root, path, newName) {
    return postJson(ROUTES.fsRename, { root, path, newName }, uiTokenHeader());
  },
  async moveEntries(root, paths, destDir, { overwrite = false } = {}) {
    return postJson(ROUTES.fsMove, { root, paths, destDir, overwrite }, uiTokenHeader());
  },
  async trashEntries(root, paths) {
    return postJson(ROUTES.fsTrash, { root, paths }, uiTokenHeader());
  },
  async watchDir(root, dir) {
    return postJson(ROUTES.fsWatch, { root, dir, clientId: CLIENT_ID }, uiTokenHeader());
  },
  async unwatchDir(root, dir) {
    return postJson(ROUTES.fsUnwatch, { root, dir, clientId: CLIENT_ID }, uiTokenHeader());
  },
  async unwatchAll() {
    return postJson(ROUTES.fsUnwatch, { clientId: CLIENT_ID, all: true }, uiTokenHeader());
  },

  // Per-agent settings
  async renameWorker(id, name) {
    return putJson(ROUTES.workerName(id), { name });
  },
  // Rename-editor lifecycle → pause/resume the auto-name micro-task. Fire-and-
  // forget from the UI: active=true on open, active=false on cancel-without-commit.
  async renameIntent(id, active) {
    return putJson(ROUTES.workerRenameIntent(id), { active });
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
  async switchWorkerBackend(id, kind) {
    return putJson(ROUTES.workerBackend(id), { kind });
  },
  async listFiles(cwd, query = "", { includeHidden = false, dir = "" } = {}) {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (query) params.set("query", query);
    if (dir) params.set("dir", dir);
    if (includeHidden) params.set("includeHidden", "1");
    const r = await getJson(`${ROUTES.fsList}?${params.toString()}`);
    if (!r.ok) throw new Error(`listFiles → ${r.status}`);
    return r.body;
  },

  // Symbol intelligence — fail-soft by design: the backend lands separately and
  // may be absent. A missing/errored endpoint resolves to `null` so the Files tab
  // degrades to a quiet no-op rather than throwing. `want` = "definitions"|"references".
  async symbolsLookup(root, name, want, fromPath) {
    if (!root || !name) return null;
    const params = new URLSearchParams({ root, name, want });
    if (fromPath) params.set("fromPath", fromPath);
    try {
      const r = await getJson(`${ROUTES.symbolsLookup}?${params.toString()}`);
      return r.ok ? (r.body ?? { occurrences: [] }) : null;
    } catch {
      return null;
    }
  },
  async symbolsSearch(root, query, limit = 50) {
    if (!root || !query) return null;
    const params = new URLSearchParams({ root, query, limit: String(limit) });
    try {
      const r = await getJson(`${ROUTES.symbolsSearch}?${params.toString()}`);
      return r.ok ? (r.body ?? { symbols: [] }) : null;
    } catch {
      return null;
    }
  },

  async listCommands(cwd) {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const r = await getJson(`${ROUTES.commands}${params}`);
    if (!r.ok) throw new Error(`listCommands → ${r.status}`);
    return r.body;
  },

  // Workflow node-editor (Phase 5).
  // Palette catalog: node kinds + their typed port shapes + live transform fns.
  async getWorkflowCatalog() {
    const r = await getJson(ROUTES.workflowCatalog);
    if (!r.ok) throw new Error(`getWorkflowCatalog → ${r.status}`);
    return r.body;
  },
  // SAVE: persist the authored v2 graph (PUT, owner=operator — the editor has no
  // agent behind it; the daemon defaults an owner-less PUT to the operator owner).
  async saveWorkflow(graph) {
    return putJson(`${ROUTES.workflows}?owner=operator`, graph);
  },
  // STOP: the ONE run-write op the Runs view exposes — abort an active run
  // (status→stopped, reaps the anchor subtree). Stays reachable even when the
  // engine is disabled. Returns the postJson envelope; body = the lean run view.
  async stopWorkflowRun(runId) {
    return postJson(ROUTES.workflows, { mode: "stop", runId });
  },
  // DELETE a stored (runtime) definition by name — the symmetric mirror of save.
  // The daemon rejects builtins (400) and unknown names (404); the Library only
  // surfaces Delete for runtime defs, so the happy path is a runtime row. Owner
  // rides the query (operator default), same as save.
  async deleteWorkflow(name) {
    return del(`${ROUTES.workflowDefinition(encodeURIComponent(name))}?owner=operator`);
  },
  // Read one run row (status + per-step rows) for the GET status read.
  async getWorkflowRun(id) {
    const r = await getJson(ROUTES.workflowRun(id));
    return r.ok ? r.body : null;
  },
  // Phase-0 read endpoints (later phases — Library + Runs — consume these). All
  // are thin GETs; each degrades to an empty list so a partial daemon never
  // throws in render.
  // Merged builtin+file+runtime definition records (Library cards + from/subGraph
  // selectors). Owner rides the query (operator default), same as save/delete.
  async listWorkflowDefinitions({ owner = "operator" } = {}) {
    const r = await getJson(`${ROUTES.workflowDefinitions}?owner=${encodeURIComponent(owner)}`);
    return r.ok ? r.body : [];
  },
  // Run list for the observation view: scope "active" (in-flight, cross-owner) or
  // "recent" (capped most-recent history).
  async listWorkflowRuns(scope = "active") {
    const r = await getJson(`${ROUTES.workflowRuns}?scope=${encodeURIComponent(scope)}`);
    return r.ok ? r.body : [];
  },
  // Per-node step rows for one run (run-detail step list + per-node coloring
  // backfill on mount).
  async getWorkflowRunSteps(id) {
    const r = await getJson(ROUTES.workflowRunSteps(id));
    return r.ok ? r.body : [];
  },
  // Worker-definition names for the node `from` / expert `from` selectors. Owner
  // is optional (omitted ⇒ builtin+user+project; the operator editor has no agent
  // row behind it). Degrades to [] so a partial daemon never throws in render.
  async listWorkerDefinitions({ owner } = {}) {
    const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
    const r = await getJson(`${ROUTES.workerDefinitions}${q}`);
    return r.ok ? r.body : [];
  },

  // Prompt templates
  async listTemplates() {
    const r = await getJson(ROUTES.templates);
    if (!r.ok) throw new Error(`listTemplates → ${r.status}`);
    return r.body;
  },
  async createTemplate({ name, description, content, attachments }) {
    return postJson(ROUTES.templates, { name, description, content, attachments });
  },
  async updateTemplate(name, { description, content, attachments }) {
    return putJson(ROUTES.template(name), { description, content, attachments });
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

  // Archive lifecycle config — lives in ~/.eos/config.json (the daemon sweeper
  // and app-closed purge read it live), so it bypasses the settings.json store.
  async getArchiveConfig() {
    const r = await getJson(ROUTES.settingsArchive);
    if (!r.ok) throw new Error(`getArchiveConfig → ${r.status}`);
    return r.body?.archive ?? {};
  },
  async patchArchiveConfig(patch) {
    return putJson(ROUTES.settingsArchive, patch);
  },

  // Auto-update — status is an open read; apply is uiToken-gated (an agent must
  // not self-update the host). Returns the postJson envelope; the banner reads
  // `.body.started` via useLive.
  async updateStatus() {
    const r = await getJson(ROUTES.updateStatus);
    return r.ok ? r.body : null;
  },
  async applyUpdate(relaunchApp = true) {
    return postJson(ROUTES.updateApply, { relaunchApp }, uiTokenHeader());
  },
  async deferUpdate() {
    return postJson(ROUTES.updateDefer);
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

  // Discard one changed file back to the diff base. Destructive (reverts the
  // working tree), so it carries the UI token like the other git mutations.
  // Resolves { ok, body } — ok is HTTP success; body.error carries git's reason.
  async discardFile(id, path) {
    return postJson(ROUTES.workerChangesDiscard(id), { path }, uiTokenHeader());
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

  // Export — triggers a browser download of conversation HTML.
  // Uses fetch + blob to avoid opening a new tab.
  async exportWorker(id, { tree = false } = {}) {
    const url = `${DAEMON}${ROUTES.workerExport(id)}?tree=${tree}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`export → ${r.status}`);
      const blob = await r.blob();
      const disposition = r.headers.get("content-disposition");
      const match = disposition?.match(/filename="?(.+?)"?$/);
      const filename = match ? match[1] : `export-${id}.html`;
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(blob);
      });
      // WKWebView (eos:// scheme) doesn't support <a download> — use native save dialog
      if (window.webkit?.messageHandlers?.saveFile) {
        window.webkit.messageHandlers.saveFile.postMessage({ filename, base64, mimeType: blob.type || "text/html" });
        return;
      }
      const a = document.createElement("a");
      a.href = `data:${blob.type};base64,${base64}`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error("export failed", e);
    }
  },

  // SSE — returns the EventSource so the caller can attach listeners. The
  // reconnect logic in store/sse.js wraps this.
  newEventStream() {
    return new EventSource(`${DAEMON}${ROUTES.stream}?clientId=${encodeURIComponent(CLIENT_ID)}`);
  },
};
