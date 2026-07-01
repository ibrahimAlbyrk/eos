// Centralized daemon route table — the single place URLs live in the
// frontend. Every fetch in the codebase resolves its path through here so a
// daemon endpoint rename is one edit, not a hunt.
//
// Mirrors contracts/src/http.ts ROUTES. Kept duplicated rather than imported
// because Vite/esbuild doesn't ergonomically pull from ../../../contracts
// without workspace config; the cost of one shadow constants file is small
// compared to the cost of misaligned URLs.

export const ROUTES = {
  health: "/health",
  stream: "/stream",
  workers: "/workers",
  worker: (id) => `/workers/${id}`,
  workerEvents: (id) => `/workers/${id}/events`,
  workerMessage: (id) => `/workers/${id}/message`,
  workerQueue: (id) => `/workers/${id}/queue`,
  workerQueueItem: (id, queueId) => `/workers/${id}/queue/${queueId}`,
  workerAction: (id) => `/workers/${id}/action`,
  workerPush: (id) => `/workers/${id}/push`,
  workerPushState: (id) => `/workers/${id}/push-state`,
  workerPull: (id) => `/workers/${id}/pull`,
  orchestrators: "/orchestrators",
  orchestratorMessage: (id) => `/orchestrators/${id}/message`,
  policyDecide: "/policy/decide",
  pending: "/pending",
  pendingDecision: (id) => `/pending/${id}/decision`,
  metrics: "/metrics",
  uiConfig: "/api/ui-config",
  pickDirectory: "/pick-directory",
  pickFile: "/pick-file",
  fsImage: "/fs/image",
  // On the raw-content listener (daemon.rawPort), not the main API port:
  fsRaw: "/fs/raw",
  pdfjs: "/pdfjs",
  fsDefaultApp: "/fs/default-app",
  fsOpen: "/fs/open",
  fsIcon: "/fs/icon",
  fsBranches: "/fs/branches",
  fsUnpushed: "/fs/unpushed",
  fsCommit: "/fs/commit",
  fsCheckout: "/fs/checkout",
  fsBranchCreate: "/fs/branch/create",
  fsBranchRename: "/fs/branch/rename",
  fsBranchDelete: "/fs/branch/delete",
  fsFetch: "/fs/fetch",
  fsRemoteBranchDelete: "/fs/remote-branch/delete",
  fsRecents: "/fs/recents",
  fsRead: "/fs/read",
  fsWrite: "/fs/write",
  fsPaste: "/fs/paste",
  fsReveal: "/fs/reveal",
  fsStat: "/fs/stat",
  fsCreate: "/fs/create",
  fsRename: "/fs/rename",
  fsMove: "/fs/move",
  fsTrash: "/fs/trash",
  fsWatch: "/fs/watch",
  fsUnwatch: "/fs/unwatch",
  workerName: (id) => `/workers/${id}/name`,
  workerRenameIntent: (id) => `/workers/${id}/rename-intent`,
  workerOpen: (id) => `/workers/${id}/open`,
  workerPermission: (id) => `/workers/${id}/permission`,
  workerModel: (id) => `/workers/${id}/model`,
  workerBackend: (id) => `/workers/${id}/backend`,
  workerDiff: (id) => `/workers/${id}/diff`,
  workerChanges: (id) => `/workers/${id}/changes`,
  workerFileDiff: (id) => `/workers/${id}/changes/file`,
  workerChangesDiscard: (id) => `/workers/${id}/changes/discard`,
  workerConflicts: (id) => `/workers/${id}/conflicts`,
  workerConflictFile: (id) => `/workers/${id}/conflicts/file`,
  workerConflictResolve: (id) => `/workers/${id}/conflicts/resolve`,
  workerMemory: (id) => `/workers/${id}/memory`,
  workerMemoryItem: (id, name) => `/workers/${id}/memory/${name}`,
  workerInterrupt: (id) => `/workers/${id}/interrupt`,
  workerKeystroke: (id) => `/workers/${id}/keystroke`,
  workerQuestionAnswer: (id) => `/workers/${id}/question-answer`,
  workerRewindTargets: (id) => `/workers/${id}/rewind-targets`,
  workerRewind: (id) => `/workers/${id}/rewind`,
  workerTerminal: (id) => `/workers/${id}/terminal`,
  terminal: "/terminal",
  terminalKill: (runId) => `/terminal/${runId}/kill`,
  workerTryState: (id) => `/workers/${id}/try/state`,
  workerTry: (id) => `/workers/${id}/try`,
  workerTryKeep: (id) => `/workers/${id}/try/keep`,
  workerTryDiscard: (id) => `/workers/${id}/try/discard`,
  commands: "/commands",
  // Workflow node-editor: catalog (palette), create/run-control (PUT/POST), run
  // read (GET). Mirrors contracts ROUTES; the catalog is a literal path served
  // before the /workflows/:id regex daemon-side.
  workflows: "/workflows",
  workflowCatalog: "/workflows/catalog",
  // Merged builtin+file+runtime definition records (Library + from/subGraph
  // selectors). Literal path — served before the /workflows/:id regex.
  workflowDefinitions: "/workflows/definitions",
  // Run list for the observation view: ?scope=active|recent. Literal path —
  // served before the /workflows/:id regex.
  workflowRuns: "/workflows/runs",
  workflowRun: (id) => `/workflows/${id}`,
  // DELETE a stored (runtime) definition by name — the symmetric mirror of the PUT
  // save. Same single-segment shape as /workflows/:id; the daemon routes DELETE
  // distinctly from GET, so no collision.
  workflowDefinition: (name) => `/workflows/${name}`,
  // Per-node step rows for one run (read-only run canvas / step list). Two-segment
  // path — no collision with the single-segment /workflows/:id regex.
  workflowRunSteps: (id) => `/workflows/${id}/steps`,
  // Worker-definition catalog (names for the node `from` / expert `from` selectors).
  // Endpoint already exists daemon-side (manager/routes/worker-definitions.ts).
  workerExport: (id) => `/workers/${id}/export`,
  workerDefinitions: "/worker-definitions",
  templates: "/api/templates",
  template: (name) => `/api/templates/${name}`,
  settings: "/api/settings",
  updateStatus: "/api/updates/status",
  updateCheck: "/api/updates/check",
  updateApply: "/api/updates/apply",
  updateDefer: "/api/updates/defer",
  fsList: "/fs/list",
  policyRule: "/api/policy/rule",
  // A configured provider's available models (two-level composer picker).
  apiBackends: "/api/backends",
  apiBackendPresets: "/api/backends/presets",
  apiBackendModels: (name) => `/api/backends/${name}/models`,
  // Ephemeral connection test — validates a provider config (preset + key) with a
  // live /v1/models call before the config is persisted.
  apiBackendTest: "/api/backends/test",
  // Delete a configured provider profile by name.
  apiBackendDelete: (name) => `/api/backends/${name}`,
};
