// Centralized daemon route table — the single place URLs live in the
// frontend. Every fetch in the codebase resolves its path through here so a
// daemon endpoint rename is one edit, not a hunt.
//
// Mirrors the core's route table (crates/eos-contracts/src/routes): a
// `cargo xtask` test compares the two entry by entry. Kept as its own file so the
// dashboard builds by itself.

export const ROUTES = {
  health: "/health",
  stream: "/stream",
  streamFocus: "/stream/focus",
  workers: "/workers",
  // Dedicated archived-only listing (dashboard-only). GET /workers takes NO
  // archived param — archived rows are unconditionally excluded there.
  workersArchived: "/workers/archived",
  worker: (id) => `/workers/${id}`,
  workerArchive: (id) => `/workers/${id}/archive`,
  workerRestore: (id) => `/workers/${id}/restore`,
  workerPurge: (id) => `/workers/${id}/purge`,
  workerEvents: (id) => `/workers/${id}/events`,
  // Whole-conversation "Files in Chat": every attachment referenced across the
  // transcript, unioned by path server-side (earliest sighting wins).
  workerAttachments: (id) => `/workers/${id}/attachments`,
  // Every prompt (+ clear/rewind/recall marker) across the whole conversation —
  // the turn rail indexes turns the paged window hasn't loaded yet.
  workerPromptEvents: (id) => `/workers/${id}/prompt-events`,
  // Every row that rebuilds the conversation's subagents — the Subagents panel
  // lists the ones the paged window hasn't loaded too.
  workerSubagentEvents: (id) => `/workers/${id}/subagent-events`,
  // The same lists as summaries (the Rust core only): every subagent, the rows
  // that rebuild one of them when its detail opens, and every artifact.
  workerSubagents: (id) => `/workers/${id}/subagents`,
  workerSubagentRows: (id, callId) => `/workers/${id}/subagents/${callId}/events`,
  // Stops one subagent of the chat, by any of its runs' call ids.
  workerSubagentStop: (id, callId) => `/workers/${id}/subagents/${callId}/stop`,
  workerArtifacts: (id) => `/workers/${id}/artifacts`,
  // Claude Code Workflow runs (eos-contracts `workflow_run.rs`).
  workerWorkflowRuns: (id) => `/workers/${id}/workflow-runs`,
  workerWorkflowRun: (id, callId) => `/workers/${id}/workflow-runs/${callId}`,
  workerWorkflowRunStop: (id, callId) => `/workers/${id}/workflow-runs/${callId}/stop`,
  // Background jobs (eos-contracts `background_job.rs`), all ui-token.
  jobs: "/api/jobs",
  jobsClear: "/api/jobs/clear",
  jobOutput: (id) => `/api/jobs/${encodeURIComponent(id)}/output`,
  jobStop: (id) => `/api/jobs/${encodeURIComponent(id)}/stop`,
  jobDismiss: (id) => `/api/jobs/${encodeURIComponent(id)}/dismiss`,
  // In-app updates (eos-contracts `update.rs`), ui-token, this Mac only.
  update: "/api/update",
  updateCheck: "/api/update/check",
  updateDownload: "/api/update/download",
  updateRestart: "/api/update/restart",
  updateLater: "/api/update/later",
  updateDismiss: "/api/update/dismiss",
  settingsUpdates: "/api/settings/updates",
  workerWorkflowAgent: (id, callId, agentId) => `/workers/${id}/workflow-runs/${callId}/agents/${agentId}`,
  // The /btw side question (eos-contracts `side_question.rs`), ui-token.
  workerSideQuestion: (id) => `/workers/${id}/btw`,
  // Emoji reactions on a chat's messages (eos-contracts `reactions.rs`): the
  // ones in a row range, and the user's own on one message (ui-token).
  workerReactions: (id) => `/workers/${id}/reactions`,
  workerReaction: (id, rowId) => `/workers/${id}/reactions/${rowId}`,
  workerMessage: (id) => `/workers/${id}/message`,
  workerWarm: (id) => `/workers/${id}/warm`,
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
  modelCatalogRefresh: "/api/model-catalog/refresh",
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
  fsLog: "/fs/log",
  fsChanges: "/fs/changes",
  fsChangesFile: "/fs/changes/file",
  fsBlob: "/fs/blob",
  fsStashes: "/fs/stashes",
  fsStashApply: "/fs/stash/apply",
  fsStashDrop: "/fs/stash/drop",
  fsOpenIn: "/fs/open-in",
  fsEditors: "/fs/editors",
  fsCheckout: "/fs/checkout",
  fsBranchCreate: "/fs/branch/create",
  fsBranchRename: "/fs/branch/rename",
  fsBranchDelete: "/fs/branch/delete",
  fsFetch: "/fs/fetch",
  fsRemoteBranchDelete: "/fs/remote-branch/delete",
  fsRecents: "/fs/recents",
  fsRecentsRemove: "/fs/recents/remove",
  projects: "/projects",
  projectsDelete: "/projects/delete",
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
  fsGitWatch: "/fs/git/watch",
  fsGitUnwatch: "/fs/git/unwatch",
  // Symbol-level code intelligence (name-matched, syntactic tier). Lookup serves
  // go-to-definition + find-references (one handler, ?want=); search backs the
  // Symbols search mode. Reads are un-gated GETs like /fs/read.
  symbolsLookup: "/symbols/lookup",
  symbolsSearch: "/symbols/search",
  symbolsFile: "/symbols/file",
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
  // Interactive multi-tab PTY sessions (the embedded terminal panel). Distinct
  // from the one-shot `!` terminal above — own `/pty*` namespace + bus events.
  pty: "/pty",
  ptySession: (id) => `/pty/${id}`,
  ptyInput: (id) => `/pty/${id}/input`,
  ptyResize: (id) => `/pty/${id}/resize`,
  ptyBuffer: (id) => `/pty/${id}/buffer`,
  workerTryState: (id) => `/workers/${id}/try/state`,
  workerTry: (id) => `/workers/${id}/try`,
  workerTryKeep: (id) => `/workers/${id}/try/keep`,
  workerTryDiscard: (id) => `/workers/${id}/try/discard`,
  commands: "/commands",
  workerExport: (id) => `/workers/${id}/export`,
  workerDefinitions: "/worker-definitions",
  templates: "/api/templates",
  template: (name) => `/api/templates/${name}`,
  pages: "/api/pages",
  page: (id) => `/api/pages/${id}`,
  pageEdit: (id) => `/api/pages/${id}/edit`,
  profile: "/api/profile",
  profilePreview: "/api/profile/preview",
  profileAvatar: "/api/profile/avatar",
  profileImportClaudeMd: "/api/profile/import/claude-md",
  userMemories: "/api/user-memories",
  userMemory: (id) => `/api/user-memories/${id}`,
  userMemoryApprove: (id) => `/api/user-memories/${id}/approve`,
  userMemoryDismiss: (id) => `/api/user-memories/${id}/dismiss`,
  userMemoriesApproveAll: "/api/user-memories/approve-all",
  dreams: "/api/dreams",
  dream: (id) => `/api/dreams/${id}`,
  dreamStatus: "/api/dreams/status",
  dreamStop: "/api/dreams/stop",
  dreamExclusions: "/api/dreams/exclusions",
  sync: "/api/sync",
  syncCreate: "/api/sync/create",
  syncJoin: "/api/sync/join",
  syncKey: "/api/sync/key",
  syncNow: "/api/sync/now",
  syncLeave: "/api/sync/leave",
  syncUsage: "/api/sync/usage",
  // File transfer (eos-contracts `transfer.rs`): /transfer/* is a daemon's own disk
  // (this Mac's, or a paired one's through /h/<id>); /api/transfers this Mac's engine.
  transferList: "/transfer/list",
  transferKey: "/transfer/key",
  transferLocate: "/transfer/locate",
  transfers: "/api/transfers",
  transferDestination: "/api/transfers/destination",
  transferPause: (id) => `/api/transfers/${id}/pause`,
  transferResume: (id) => `/api/transfers/${id}/resume`,
  transferCancel: (id) => `/api/transfers/${id}/cancel`,
  transferDecide: (id) => `/api/transfers/${id}/decide`,
  settings: "/api/settings",
  settingsArchive: "/api/settings/archive",
  settingsCompaction: "/api/settings/compaction",
  // Visual answers (eos-contracts `genui.rs`). settingsGenui GET/PUT (ui-token)
  // is the only write path for location.share and the logo.dev key.
  settingsGenui: "/api/settings/genui",
  genuiViews: "/api/genui/views",
  genuiView: (id) => `/api/genui/views/${id}`,
  genuiViewState: (id) => `/api/genui/views/${id}/state`,
  genuiApps: "/api/genui/apps",
  genuiMediaImg: "/api/genui/media/img",
  genuiMediaOg: "/api/genui/media/og",
  genuiMediaIcon: "/api/genui/media/icon",
  // Prefix: style at /style.json, tiles under /t/<path>.
  genuiMap: "/api/genui/map",
  genuiGeocode: "/api/genui/geocode",
  genuiPlaces: "/api/genui/places",
  // Local-only (never through a /h/<id> facade); 403 unless location sharing is on.
  location: "/api/location",
  // Remote access (iOS relay v3) — loopback + ui-token only. status read; config
  // write (persist config.remote); arm (reload+reconcile the edge); pair (mint QR).
  remoteStatus: "/api/remote/status",
  remoteConfig: "/api/remote/config",
  remoteArm: "/api/remote/arm",
  remotePair: "/api/remote/pair",
  // Wakes the paired phone with a test push through the relay.
  remotePushTest: "/api/remote/push-test",
  // Eos ↔ Eos peering (eos-contracts `peer.rs`).
  hostInfo: "/api/host",
  peer: "/api/peer",
  peerInvite: "/api/peer/invite",
  peerDevice: (fp) => `/api/peer/devices/${fp}`,
  peerDeviceDisconnect: (fp) => `/api/peer/devices/${fp}/disconnect`,
  hosts: "/api/hosts",
  host: (id) => `/api/hosts/${id}`,
  hostReconnect: (id) => `/api/hosts/${id}/reconnect`,
  hostProxyPrefix: (id) => `/h/${id}`,
  // Claude creds for the claude lane (Settings › Accounts) — loopback +
  // ui-token only. GET returns redacted { apiKeySet, authTokenSet }; PUT persists.
  anthropicConfig: "/api/anthropic/config",
  // Subscription usage snapshot (Settings > Usage) — open read; daemon answers
  // from its held UsageResponse at once (`?wait=1` waits for a stale one's refresh).
  usage: "/api/usage",
  // Every artifact of every Claude sign-in (eos-contracts `artifacts.rs`) —
  // ui-token, this Mac only.
  artifacts: "/api/artifacts",
  artifactsRefresh: "/api/artifacts/refresh",
  // Plugins (eos-contracts `plugin.rs`) — writes are ui-token.
  plugins: "/api/plugins",
  plugin: (id) => `/api/plugins/${encodeURIComponent(id)}`,
  pluginReport: (id) => `/api/plugins/${encodeURIComponent(id)}/report`,
  pluginEnabled: (id) => `/api/plugins/${encodeURIComponent(id)}/enabled`,
  pluginSettings: (id) => `/api/plugins/${encodeURIComponent(id)}/settings`,
  pluginStore: (id, key) => `/api/plugins/${encodeURIComponent(id)}/store/${encodeURIComponent(key)}`,
  pluginInstall: "/api/plugins/install",
  pluginStaged: (stagingId) => `/api/plugins/install/${encodeURIComponent(stagingId)}`,
  pluginUpdate: (id) => `/api/plugins/${encodeURIComponent(id)}/update`,
  fsList: "/fs/list",
  policyRule: "/api/policy/rule",
  // The providers a chat can run on besides Claude, each with its models
  // (eos-contracts `providers.rs`).
  apiProviders: "/api/providers",
  // A configured provider's available models (two-level composer picker).
  apiBackends: "/api/backends",
  apiBackendPresets: "/api/backends/presets",
  apiBackendModels: (name) => `/api/backends/${name}/models`,
  // Ephemeral connection test — validates a provider config (preset + key) with a
  // live /v1/models call before the config is persisted.
  apiBackendTest: "/api/backends/test",
  // Delete a configured provider profile by name.
  apiBackendDelete: (name) => `/api/backends/${name}`,
  // Settings › Accounts — loopback + ui-token only, redacted.
  accounts: "/api/accounts",
  accountSignIn: (provider) => `/api/accounts/${provider}/sign-in`,
  accountLogin: (provider, id) => `/api/accounts/${provider}/logins/${id}`,
  accountDefaultLogin: (provider) => `/api/accounts/${provider}/default-login`,
  accountAutoSwitch: (provider) => `/api/accounts/${provider}/auto-switch`,
  workerPlanResume: (id) => `/workers/${id}/plan-resume`,
  workerApiKeyContinue: (id) => `/workers/${id}/api-key-continue`,
  workerAccount: (id) => `/workers/${id}/account`,
  signIn: (id) => `/api/sign-ins/${id}`,
  signInCode: (id) => `/api/sign-ins/${id}/code`,
  // Browser panel — the daemon's single Chrome over CDP. Loopback + ui-token
  // gated like /pty. Frames never come through here; they ride the binary
  // WebSocket at /browser/stream.
  browserStatus: "/browser/status",
  browserLaunch: "/browser/launch",
  browserTabs: "/browser/tabs",
  // Omitted-tabId default: the active (foreground) tab. 200 { tabId } | 409.
  browserActiveTab: "/browser/active-tab",
  // Present: an agent surfaces the panel showing a tab. Session scoping of the
  // tabs/active-tab/status routes rides ?session= (no new keys).
  browserShow: "/browser/show",
  browserTab: (tabId) => `/browser/tabs/${tabId}`,
  browserNavigate: (tabId) => `/browser/tabs/${tabId}/navigate`,
  browserSnapshot: (tabId) => `/browser/tabs/${tabId}/snapshot`,
  browserFind: (tabId) => `/browser/tabs/${tabId}/find`,
  browserWait: (tabId) => `/browser/tabs/${tabId}/wait`,
  browserAct: (tabId) => `/browser/tabs/${tabId}/act`,
  browserGet: (tabId) => `/browser/tabs/${tabId}/get`,
  browserCapture: (tabId) => `/browser/tabs/${tabId}/capture`,
  browserDevice: (tabId) => `/browser/tabs/${tabId}/device`,
  browserElements: (tabId) => `/browser/tabs/${tabId}/elements`,
  browserMute: (tabId) => `/browser/tabs/${tabId}/mute`,
  // Routines (eos-contracts `routine.rs`): the list, which also tells whether
  // the core serves them, one routine, its versions and one version.
  routines: "/api/routines",
  routine: (id) => `/api/routines/${id}`,
  routineVersions: (id) => `/api/routines/${id}/versions`,
  routineVersion: (id, versionId) => `/api/routines/${id}/versions/${versionId}`,
  // Writing a routine's blueprint: make one by hand, keep a new version from
  // the head, bring an old version back, start another like it; the budgets
  // for all routines.
  routineBlueprint: (id) => `/api/routines/${id}/blueprint`,
  routineVersionRestore: (id, versionId) => `/api/routines/${id}/versions/${versionId}/restore`,
  routineCopy: (id) => `/api/routines/${id}/copy`,
  routinesSettings: "/api/routines/settings",
  // A routine's life by hand: its state, Recently deleted and back, a one-off kept.
  routineState: (id) => `/api/routines/${id}/state`,
  routineUndelete: (id) => `/api/routines/${id}/undelete`,
  routineKeep: (id) => `/api/routines/${id}/keep`,
  // Making and changing a routine by talking to its architect: make one from a
  // sentence, start its draft, ask for a change, the draft and a message to
  // its architect, and a trial on real past items.
  routinesArchitect: "/api/routines/architect",
  routineStart: (id) => `/api/routines/${id}/start`,
  routineChange: (id) => `/api/routines/${id}/change`,
  routineDraft: (id) => `/api/routines/${id}/draft`,
  routineDraftMessage: (id) => `/api/routines/${id}/draft/message`,
  routineTrial: (id) => `/api/routines/${id}/trial`,
  // What a sentence typed at Home asks for, by the rules and by a small
  // model, and which routines take a thing the user dropped.
  routinesIntent: "/api/routines/intent",
  routinesIntentModel: "/api/routines/intent/model",
  routinesMatchItem: "/api/routines/match-item",
  // Runs (eos-contracts `routine/runs.rs`): what a routine may run on; start,
  // estimate and list runs; one run, its result and timeline; telling its
  // team something, stopping, pausing and resuming it; and the run a worker
  // works for.
  routineCandidates: (id) => `/api/routines/${id}/candidates`,
  runs: "/api/runs",
  runsEstimate: "/api/runs/estimate",
  // What runs:active carries, before its first event.
  runsActive: "/api/runs/active",
  // The runs that ended since a time, counted by how and by routine.
  runsSummary: "/api/runs/summary",
  run: (id) => `/api/runs/${id}`,
  runResult: (id) => `/api/runs/${id}/result`,
  runEvents: (id) => `/api/runs/${id}/events`,
  runMessage: (id) => `/api/runs/${id}/message`,
  runStop: (id) => `/api/runs/${id}/stop`,
  runPause: (id) => `/api/runs/${id}/pause`,
  runResume: (id) => `/api/runs/${id}/resume`,
  runAgent: (workerId) => `/api/run-agents/${workerId}`,
  // Signals (eos-contracts `signals.rs`): when each routine runs next, what
  // starts one routine's runs, the signal list, the counts, replay, the two
  // previews and the setting; then
  // which computer holds each routine, and moving one to this computer.
  signalsRoutines: "/api/signals/routines",
  signalsRoutine: (routineId) => `/api/signals/routines/${routineId}`,
  signals: "/api/signals",
  signalsSummary: "/api/signals/summary",
  signalsReplay: "/api/signals/replay",
  signalsSchedulePreview: "/api/signals/schedule/preview",
  signalsWhichPreview: "/api/signals/which/preview",
  signalsSettings: "/api/signals/settings",
  runners: "/api/runners",
  runnersClaim: "/api/runners/claim",
  // Needs you (eos-contracts `inbox.rs`): the items, one item, saving a
  // draft, sending, answering, putting aside and discarding one; one
  // delivery and stopping, undoing, retrying or flagging it; a routine's
  // Freedom; the switch that stops every routine; when Needs you may
  // interrupt.
  inbox: "/api/inbox",
  inboxItem: (id) => `/api/inbox/${id}`,
  inboxDraft: (id) => `/api/inbox/${id}/draft`,
  inboxSend: (id) => `/api/inbox/${id}/send`,
  inboxAnswer: (id) => `/api/inbox/${id}/answer`,
  inboxLater: (id) => `/api/inbox/${id}/later`,
  inboxDiscard: (id) => `/api/inbox/${id}/discard`,
  inboxDelivery: (id) => `/api/inbox/deliveries/${id}`,
  inboxDeliveryStop: (id) => `/api/inbox/deliveries/${id}/stop`,
  inboxDeliveryUndo: (id) => `/api/inbox/deliveries/${id}/undo`,
  inboxDeliveryRetry: (id) => `/api/inbox/deliveries/${id}/retry`,
  inboxDeliveryWrong: (id) => `/api/inbox/deliveries/${id}/wrong`,
  routineFreedom: (id) => `/api/routines/${id}/freedom`,
  eosHalt: "/api/eos/halt",
  eosResume: "/api/eos/resume",
  settingsAttention: "/api/settings/attention",
  // Capabilities (eos-contracts `capability.rs`): the list, what a
  // capability can list for the user to pick, one capability (and removing
  // it), switching it on and off, its settings, checking it now, going back
  // to an earlier version, and signing in.
  capabilities: "/api/capabilities",
  capabilityCandidates: "/api/capabilities/candidates",
  capability: (id) => `/api/capabilities/${id}`,
  capabilityEnable: (id) => `/api/capabilities/${id}/enable`,
  capabilityDisable: (id) => `/api/capabilities/${id}/disable`,
  capabilitySettings: (id) => `/api/capabilities/${id}/settings`,
  capabilityCheck: (id) => `/api/capabilities/${id}/check`,
  capabilityRollback: (id) => `/api/capabilities/${id}/rollback`,
  capabilitySignIn: (id) => `/api/capabilities/${id}/sign-in`,
  // Memory (eos-contracts `experience.rs`): the screen's head, the notes,
  // one note (editing and forgetting it), bringing a forgotten one back,
  // saying one is not right, what a chat or a run was reminded of, where
  // stated rules were said, and the Learning and Reminders switches.
  memorySummary: "/api/memory/summary",
  memoryNotes: "/api/memory/notes",
  memoryNote: (id) => `/api/memory/notes/${id}`,
  memoryNoteRestore: (id) => `/api/memory/notes/${id}/restore`,
  memoryNoteNotRight: (id) => `/api/memory/notes/${id}/not-right`,
  memoryRecalled: "/api/memory/recalled",
  memoryStated: "/api/memory/stated",
  memorySettings: "/api/memory/settings",
  memoryTidy: "/api/memory/tidy",
};
