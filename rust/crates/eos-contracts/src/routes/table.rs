//! The route table: `ROUTES` of `contracts/src/http.ts`, with the methods each path answers.

use super::Method::{Delete, Get, Head, Post, Put};
use super::Route;

pub const HEALTH: Route = Route::new("health", "/health", &[Get]);
pub const STREAM: Route = Route::new("stream", "/stream", &[Get]);
pub const STREAM_FOCUS: Route = Route::new("streamFocus", "/stream/focus", &[Post]);
pub const WORKERS: Route = Route::new("workers", "/workers", &[Get, Post]);
pub const WORKERS_ARCHIVED: Route = Route::new("workersArchived", "/workers/archived", &[Get]);
pub const WORKERS_ARCHIVED_APP_CLOSED: Route =
    Route::new("workersArchivedAppClosed", "/workers/archived/app-closed", &[Post]);
pub const WORKER: Route = Route::new("worker", "/workers/:id", &[Get, Delete]);
pub const WORKER_EVENTS: Route = Route::new("workerEvents", "/workers/:id/events", &[Get, Post]);
pub const WORKER_ATTACHMENTS: Route = Route::new("workerAttachments", "/workers/:id/attachments", &[Get]);
pub const WORKER_PROMPT_EVENTS: Route = Route::new("workerPromptEvents", "/workers/:id/prompt-events", &[Get]);
pub const WORKER_SUBAGENT_EVENTS: Route = Route::new("workerSubagentEvents", "/workers/:id/subagent-events", &[Get]);
pub const WORKER_WORKFLOW_RUNS: Route = Route::new("workerWorkflowRuns", "/workers/:id/workflow-runs", &[Get]);
pub const WORKER_WORKFLOW_RUN: Route = Route::new("workerWorkflowRun", "/workers/:id/workflow-runs/:callId", &[Get]);
pub const WORKER_WORKFLOW_RUN_STOP: Route =
    Route::new("workerWorkflowRunStop", "/workers/:id/workflow-runs/:callId/stop", &[Post]);
pub const WORKER_WORKFLOW_AGENT: Route =
    Route::new("workerWorkflowAgent", "/workers/:id/workflow-runs/:callId/agents/:agentId", &[Get]);
pub const WORKER_SIDE_QUESTION: Route = Route::new("workerSideQuestion", "/workers/:id/btw", &[Post]);
pub const WORKER_MESSAGE: Route = Route::new("workerMessage", "/workers/:id/message", &[Post]);
pub const WORKER_WARM: Route = Route::new("workerWarm", "/workers/:id/warm", &[Post]);
pub const WORKER_QUEUE: Route = Route::new("workerQueue", "/workers/:id/queue", &[Get]);
pub const WORKER_QUEUE_ITEM: Route = Route::new("workerQueueItem", "/workers/:id/queue/:queueId", &[Delete]);
pub const WORKER_ACTION: Route = Route::new("workerAction", "/workers/:id/action", &[Post]);
pub const WORKER_PUSH: Route = Route::new("workerPush", "/workers/:id/push", &[Post]);
pub const WORKER_PUSH_STATE: Route = Route::new("workerPushState", "/workers/:id/push-state", &[Get]);
pub const WORKER_PULL: Route = Route::new("workerPull", "/workers/:id/pull", &[Post]);
pub const ORCHESTRATORS: Route = Route::new("orchestrators", "/orchestrators", &[Get, Post]);
pub const ORCHESTRATOR_MESSAGE: Route = Route::new("orchestratorMessage", "/orchestrators/:id/message", &[Post]);
pub const ORCHESTRATOR_INTEGRATE: Route = Route::new("orchestratorIntegrate", "/orchestrators/:id/integrate", &[Post]);
pub const ORCHESTRATOR_LOOP: Route = Route::new("orchestratorLoop", "/orchestrators/:id/loop", &[Post]);
pub const ORCHESTRATOR_LOOP_STOP: Route = Route::new("orchestratorLoopStop", "/orchestrators/:id/loop/stop", &[Post]);
pub const POLICY_DECIDE: Route = Route::new("policyDecide", "/policy/decide", &[Post]);
pub const POLICY_RULE: Route = Route::new("policyRule", "/api/policy/rule", &[Post]);
pub const PENDING: Route = Route::new("pending", "/pending", &[Get]);
pub const PENDING_DECISION: Route = Route::new("pendingDecision", "/pending/:id/decision", &[Post]);
pub const METRICS: Route = Route::new("metrics", "/metrics", &[Get]);
pub const DATETIME: Route = Route::new("datetime", "/datetime", &[Get]);
pub const UI_CONFIG: Route = Route::new("uiConfig", "/api/ui-config", &[Get]);
pub const MODEL_CATALOG_REFRESH: Route = Route::new("modelCatalogRefresh", "/api/model-catalog/refresh", &[Post]);
pub const PICK_DIRECTORY: Route = Route::new("pickDirectory", "/pick-directory", &[Get]);
pub const PICK_FILE: Route = Route::new("pickFile", "/pick-file", &[Get]);
pub const FS_DEFAULT_APP: Route = Route::new("fsDefaultApp", "/fs/default-app", &[Get]);
pub const FS_OPEN: Route = Route::new("fsOpen", "/fs/open", &[Post]);
pub const FS_ICON: Route = Route::new("fsIcon", "/fs/icon", &[Get]);
pub const FS_BRANCHES: Route = Route::new("fsBranches", "/fs/branches", &[Get]);
pub const FS_UNPUSHED: Route = Route::new("fsUnpushed", "/fs/unpushed", &[Get]);
pub const FS_COMMIT: Route = Route::new("fsCommit", "/fs/commit", &[Get]);
pub const FS_LOG: Route = Route::new("fsLog", "/fs/log", &[Get]);
pub const FS_CHANGES: Route = Route::new("fsChanges", "/fs/changes", &[Get]);
pub const FS_CHANGES_FILE: Route = Route::new("fsChangesFile", "/fs/changes/file", &[Get]);
pub const FS_BLOB: Route = Route::new("fsBlob", "/fs/blob", &[Get]);
pub const FS_STASHES: Route = Route::new("fsStashes", "/fs/stashes", &[Get]);
pub const FS_STASH_APPLY: Route = Route::new("fsStashApply", "/fs/stash/apply", &[Post]);
pub const FS_STASH_DROP: Route = Route::new("fsStashDrop", "/fs/stash/drop", &[Post]);
pub const FS_RECENTS: Route = Route::new("fsRecents", "/fs/recents", &[Get]);
pub const FS_RECENTS_REMOVE: Route = Route::new("fsRecentsRemove", "/fs/recents/remove", &[Post]);
pub const PROJECTS: Route = Route::new("projects", "/projects", &[Get, Put]);
pub const PROJECTS_DELETE: Route = Route::new("projectsDelete", "/projects/delete", &[Post]);
pub const FS_REVEAL: Route = Route::new("fsReveal", "/fs/reveal", &[Post]);
pub const FS_OPEN_IN: Route = Route::new("fsOpenIn", "/fs/open-in", &[Post]);
pub const FS_EDITORS: Route = Route::new("fsEditors", "/fs/editors", &[Get]);
pub const FS_READ: Route = Route::new("fsRead", "/fs/read", &[Get]);
pub const FS_LIST: Route = Route::new("fsList", "/fs/list", &[Get]);
pub const FS_IMAGE: Route = Route::new("fsImage", "/fs/image", &[Get]);
pub const FS_RAW: Route = Route::new("fsRaw", "/fs/raw", &[Get]).as_prefix();
pub const PDFJS: Route = Route::new("pdfjs", "/pdfjs", &[Get]).as_prefix();
pub const FS_CHECKOUT: Route = Route::new("fsCheckout", "/fs/checkout", &[Post]);
pub const FS_BRANCH_CREATE: Route = Route::new("fsBranchCreate", "/fs/branch/create", &[Post]);
pub const FS_BRANCH_RENAME: Route = Route::new("fsBranchRename", "/fs/branch/rename", &[Post]);
pub const FS_BRANCH_DELETE: Route = Route::new("fsBranchDelete", "/fs/branch/delete", &[Post]);
pub const FS_FETCH: Route = Route::new("fsFetch", "/fs/fetch", &[Post]);
pub const FS_REMOTE_BRANCH_DELETE: Route = Route::new("fsRemoteBranchDelete", "/fs/remote-branch/delete", &[Post]);
pub const FS_WRITE: Route = Route::new("fsWrite", "/fs/write", &[Post]);
pub const FS_PASTE: Route = Route::new("fsPaste", "/fs/paste", &[Post]);
pub const FS_PASTE_B64: Route = Route::new("fsPasteB64", "/fs/paste-b64", &[Post]);
pub const FS_STAT: Route = Route::new("fsStat", "/fs/stat", &[Get]);
pub const FS_CREATE: Route = Route::new("fsCreate", "/fs/create", &[Post]);
pub const FS_RENAME: Route = Route::new("fsRename", "/fs/rename", &[Post]);
pub const FS_MOVE: Route = Route::new("fsMove", "/fs/move", &[Post]);
pub const FS_TRASH: Route = Route::new("fsTrash", "/fs/trash", &[Post]);
pub const FS_WATCH: Route = Route::new("fsWatch", "/fs/watch", &[Post]);
pub const FS_UNWATCH: Route = Route::new("fsUnwatch", "/fs/unwatch", &[Post]);
pub const FS_GIT_WATCH: Route = Route::new("fsGitWatch", "/fs/git/watch", &[Post]);
pub const FS_GIT_UNWATCH: Route = Route::new("fsGitUnwatch", "/fs/git/unwatch", &[Post]);
pub const SYMBOLS_LOOKUP: Route = Route::new("symbolsLookup", "/symbols/lookup", &[Get]);
pub const SYMBOLS_SEARCH: Route = Route::new("symbolsSearch", "/symbols/search", &[Get]);
pub const SYMBOLS_FILE: Route = Route::new("symbolsFile", "/symbols/file", &[Get]);
pub const WORKER_NAME: Route = Route::new("workerName", "/workers/:id/name", &[Put]);
pub const WORKER_RENAME_INTENT: Route = Route::new("workerRenameIntent", "/workers/:id/rename-intent", &[Put]);
pub const WORKER_OPEN: Route = Route::new("workerOpen", "/workers/:id/open", &[Post]);
pub const WORKER_PERMISSION: Route = Route::new("workerPermission", "/workers/:id/permission", &[Put]);
pub const WORKER_MODEL: Route = Route::new("workerModel", "/workers/:id/model", &[Put]);
pub const WORKER_BACKEND: Route = Route::new("workerBackend", "/workers/:id/backend", &[Put]);
pub const WORKER_DIFF: Route = Route::new("workerDiff", "/workers/:id/diff", &[Get]);
pub const WORKER_CHANGES: Route = Route::new("workerChanges", "/workers/:id/changes", &[Get]);
pub const WORKER_FILE_DIFF: Route = Route::new("workerFileDiff", "/workers/:id/changes/file", &[Get]);
pub const WORKER_CHANGES_DISCARD: Route = Route::new("workerChangesDiscard", "/workers/:id/changes/discard", &[Post]);
pub const WORKER_CONFLICTS: Route = Route::new("workerConflicts", "/workers/:id/conflicts", &[Get]);
pub const WORKER_CONFLICT_FILE: Route = Route::new("workerConflictFile", "/workers/:id/conflicts/file", &[Get]);
pub const WORKER_CONFLICT_RESOLVE: Route =
    Route::new("workerConflictResolve", "/workers/:id/conflicts/resolve", &[Post]);
pub const WORKER_MEMORY: Route = Route::new("workerMemory", "/workers/:id/memory", &[Get]);
pub const WORKER_MEMORY_ITEM: Route = Route::new("workerMemoryItem", "/workers/:id/memory/:name", &[Delete]);
pub const WORKER_INTERRUPT: Route = Route::new("workerInterrupt", "/workers/:id/interrupt", &[Post]);
pub const WORKER_RESUME: Route = Route::new("workerResume", "/workers/:id/resume", &[Post]);
pub const WORKER_ARCHIVE: Route = Route::new("workerArchive", "/workers/:id/archive", &[Post]);
pub const WORKER_RESTORE: Route = Route::new("workerRestore", "/workers/:id/restore", &[Post]);
pub const WORKER_PURGE: Route = Route::new("workerPurge", "/workers/:id/purge", &[Delete]);
pub const WORKER_KEYSTROKE: Route = Route::new("workerKeystroke", "/workers/:id/keystroke", &[Post]);
pub const WORKER_QUESTION: Route = Route::new("workerQuestion", "/workers/:id/question", &[Post]);
pub const WORKER_QUESTION_POLL: Route = Route::new("workerQuestionPoll", "/workers/:id/question/:questionId", &[Get]);
pub const WORKER_QUESTION_ANSWER: Route = Route::new("workerQuestionAnswer", "/workers/:id/question-answer", &[Post]);
pub const WORKER_PEERS: Route = Route::new("workerPeers", "/workers/:id/peers", &[Get]);
pub const WORKER_PEER_REQUEST: Route = Route::new("workerPeerRequest", "/workers/:fromWorker/peer-request", &[Post]);
pub const WORKER_PEER_REQUEST_POLL: Route =
    Route::new("workerPeerRequestPoll", "/workers/:fromWorker/peer-request/:requestId", &[Get]);
pub const WORKER_PEER_RESPONSE: Route = Route::new("workerPeerResponse", "/workers/:id/peer-response", &[Post]);
pub const WORKER_NOTIFY: Route = Route::new("workerNotify", "/workers/:id/notify", &[Post]);
pub const WORKER_REPORT: Route = Route::new("workerReport", "/workers/:id/report", &[Post]);
pub const WORKER_REWIND_TARGETS: Route = Route::new("workerRewindTargets", "/workers/:id/rewind-targets", &[Get]);
pub const WORKER_REWIND: Route = Route::new("workerRewind", "/workers/:id/rewind", &[Post]);
pub const WORKER_TERMINAL: Route = Route::new("workerTerminal", "/workers/:id/terminal", &[Post]);
pub const TERMINAL: Route = Route::new("terminal", "/terminal", &[Post]);
pub const TERMINAL_KILL: Route = Route::new("terminalKill", "/terminal/:runId/kill", &[Post]);
pub const PTY: Route = Route::new("pty", "/pty", &[Get, Post]);
pub const PTY_SESSION: Route = Route::new("ptySession", "/pty/:id", &[Delete]);
pub const PTY_INPUT: Route = Route::new("ptyInput", "/pty/:id/input", &[Post]);
pub const PTY_RESIZE: Route = Route::new("ptyResize", "/pty/:id/resize", &[Post]);
pub const PTY_BUFFER: Route = Route::new("ptyBuffer", "/pty/:id/buffer", &[Get]);
pub const PTY_CONVERSATION: Route = Route::new("ptyConversation", "/pty/:id/conversation", &[Get]);
pub const PTY_MESSAGE: Route = Route::new("ptyMessage", "/pty/:id/message", &[Post]);
pub const PTY_ANSWER: Route = Route::new("ptyAnswer", "/pty/:id/answer", &[Post]);
pub const WORKER_TRY_PREVIEW: Route = Route::new("workerTryPreview", "/workers/:id/try/preview", &[Get]);
pub const WORKER_TRY_STATE: Route = Route::new("workerTryState", "/workers/:id/try/state", &[Get]);
pub const WORKER_TRY: Route = Route::new("workerTry", "/workers/:id/try", &[Post]);
pub const WORKER_TRY_KEEP: Route = Route::new("workerTryKeep", "/workers/:id/try/keep", &[Post]);
pub const WORKER_TRY_DISCARD: Route = Route::new("workerTryDiscard", "/workers/:id/try/discard", &[Post]);
pub const COMMANDS: Route = Route::new("commands", "/commands", &[Get]);
pub const TEMPLATES: Route = Route::new("templates", "/api/templates", &[Get, Post]);
pub const TEMPLATE: Route = Route::new("template", "/api/templates/:name", &[Put, Delete]);
pub const PAGES: Route = Route::new("pages", "/api/pages", &[Get, Post]);
pub const PAGE: Route = Route::new("page", "/api/pages/:id", &[Get, Put, Delete]);
pub const PAGE_EDIT: Route = Route::new("pageEdit", "/api/pages/:id/edit", &[Post]);
pub const PROFILE: Route = Route::new("profile", "/api/profile", &[Get, Put]);
pub const PROFILE_PREVIEW: Route = Route::new("profilePreview", "/api/profile/preview", &[Get]);
pub const PROFILE_AVATAR: Route = Route::new("profileAvatar", "/api/profile/avatar", &[Get, Put, Delete]);
pub const PROFILE_IMPORT_CLAUDE_MD: Route =
    Route::new("profileImportClaudeMd", "/api/profile/import/claude-md", &[Get]);
pub const USER_MEMORIES: Route = Route::new("userMemories", "/api/user-memories", &[Get, Post]);
pub const USER_MEMORY: Route = Route::new("userMemory", "/api/user-memories/:id", &[Put, Delete]);
pub const USER_MEMORY_APPROVE: Route = Route::new("userMemoryApprove", "/api/user-memories/:id/approve", &[Post]);
pub const USER_MEMORY_DISMISS: Route = Route::new("userMemoryDismiss", "/api/user-memories/:id/dismiss", &[Post]);
pub const USER_MEMORIES_APPROVE_ALL: Route =
    Route::new("userMemoriesApproveAll", "/api/user-memories/approve-all", &[Post]);
pub const USER_MEMORY_SUGGEST: Route = Route::new("userMemorySuggest", "/api/user-memories/suggest", &[Post]);
pub const USER_MEMORY_SEARCH: Route = Route::new("userMemorySearch", "/api/user-memories/search", &[Get]);
pub const JOBS: Route = Route::new("jobs", "/api/jobs", &[Get]);
pub const JOBS_CLEAR: Route = Route::new("jobsClear", "/api/jobs/clear", &[Post]);
pub const JOB_OUTPUT: Route = Route::new("jobOutput", "/api/jobs/:id/output", &[Get]).encoding(&["id"]);
pub const JOB_STOP: Route = Route::new("jobStop", "/api/jobs/:id/stop", &[Post]).encoding(&["id"]);
pub const JOB_DISMISS: Route = Route::new("jobDismiss", "/api/jobs/:id/dismiss", &[Post]).encoding(&["id"]);
pub const UPDATE: Route = Route::new("update", "/api/update", &[Get]);
pub const UPDATE_CHECK: Route = Route::new("updateCheck", "/api/update/check", &[Post]);
pub const UPDATE_DOWNLOAD: Route = Route::new("updateDownload", "/api/update/download", &[Post]);
pub const UPDATE_RESTART: Route = Route::new("updateRestart", "/api/update/restart", &[Post]);
pub const UPDATE_LATER: Route = Route::new("updateLater", "/api/update/later", &[Post]);
pub const UPDATE_DISMISS: Route = Route::new("updateDismiss", "/api/update/dismiss", &[Post]);
pub const SETTINGS_UPDATES: Route = Route::new("settingsUpdates", "/api/settings/updates", &[Put]);
pub const DREAMS: Route = Route::new("dreams", "/api/dreams", &[Get, Post]);
pub const DREAM: Route = Route::new("dream", "/api/dreams/:id", &[Get]);
pub const DREAM_STATUS: Route = Route::new("dreamStatus", "/api/dreams/status", &[Get]);
pub const DREAM_STOP: Route = Route::new("dreamStop", "/api/dreams/stop", &[Post]);
pub const DREAM_EXCLUSIONS: Route = Route::new("dreamExclusions", "/api/dreams/exclusions", &[Post]);
pub const SYNC: Route = Route::new("sync", "/api/sync", &[Get]);
pub const SYNC_CREATE: Route = Route::new("syncCreate", "/api/sync/create", &[Post]);
pub const SYNC_JOIN: Route = Route::new("syncJoin", "/api/sync/join", &[Post]);
pub const SYNC_KEY: Route = Route::new("syncKey", "/api/sync/key", &[Get]);
pub const SYNC_NOW: Route = Route::new("syncNow", "/api/sync/now", &[Post]);
pub const SYNC_LEAVE: Route = Route::new("syncLeave", "/api/sync/leave", &[Post]);
pub const TRANSFER_LIST: Route = Route::new("transferList", "/transfer/list", &[Get]);
pub const TRANSFER_SCAN: Route = Route::new("transferScan", "/transfer/scan", &[Post]);
pub const TRANSFER_READ: Route = Route::new("transferRead", "/transfer/read", &[Get]);
pub const TRANSFER_WRITE: Route = Route::new("transferWrite", "/transfer/write", &[Put]);
pub const TRANSFER_PREPARE: Route = Route::new("transferPrepare", "/transfer/prepare", &[Post]);
pub const TRANSFER_COMMIT: Route = Route::new("transferCommit", "/transfer/commit", &[Post]);
pub const TRANSFER_ABORT: Route = Route::new("transferAbort", "/transfer/abort", &[Post]);
pub const TRANSFER_KEY: Route = Route::new("transferKey", "/transfer/key", &[Post]);
pub const TRANSFER_LOCATE: Route = Route::new("transferLocate", "/transfer/locate", &[Post]);
pub const TRANSFERS: Route = Route::new("transfers", "/api/transfers", &[Get, Post, Delete]);
pub const TRANSFER_DESTINATION: Route = Route::new("transferDestination", "/api/transfers/destination", &[Post]);
pub const TRANSFER_PAUSE: Route = Route::new("transferPause", "/api/transfers/:id/pause", &[Post]);
pub const TRANSFER_RESUME: Route = Route::new("transferResume", "/api/transfers/:id/resume", &[Post]);
pub const TRANSFER_CANCEL: Route = Route::new("transferCancel", "/api/transfers/:id/cancel", &[Post]);
pub const TRANSFER_DECIDE: Route = Route::new("transferDecide", "/api/transfers/:id/decide", &[Post]);
pub const WORKER_TRANSFERS: Route = Route::new("workerTransfers", "/workers/:id/transfers", &[Post]);
pub const WORKER_TRANSFER: Route = Route::new("workerTransfer", "/workers/:id/transfers/:transferId", &[Get]);
pub const PROMPTS: Route = Route::new("prompts", "/api/prompts", &[Get]);
pub const PROMPT_PREVIEW: Route = Route::new("promptPreview", "/api/prompts/preview", &[Post]);
pub const WORKER_EXPORT: Route = Route::new("workerExport", "/workers/:id/export", &[Get]);
pub const WORKER_DEFINITIONS: Route = Route::new("workerDefinitions", "/worker-definitions", &[Get, Post]);
pub const SETTINGS: Route = Route::new("settings", "/api/settings", &[Get, Put]);
pub const SETTINGS_ARCHIVE: Route = Route::new("settingsArchive", "/api/settings/archive", &[Get, Put]);
pub const SETTINGS_COMPACTION: Route = Route::new("settingsCompaction", "/api/settings/compaction", &[Get, Put]);
pub const SETTINGS_GENUI: Route = Route::new("settingsGenui", "/api/settings/genui", &[Get, Put]);
pub const GENUI_VIEWS: Route = Route::new("genuiViews", "/api/genui/views", &[Post]);
pub const GENUI_VIEW: Route = Route::new("genuiView", "/api/genui/views/:id", &[Get]);
pub const GENUI_VIEW_STATE: Route = Route::new("genuiViewState", "/api/genui/views/:id/state", &[Get, Put]);
pub const GENUI_APPS: Route = Route::new("genuiApps", "/api/genui/apps", &[Post]);
pub const GENUI_MEDIA_IMG: Route = Route::new("genuiMediaImg", "/api/genui/media/img", &[Get]);
pub const GENUI_MEDIA_OG: Route = Route::new("genuiMediaOg", "/api/genui/media/og", &[Get]);
pub const GENUI_MEDIA_ICON: Route = Route::new("genuiMediaIcon", "/api/genui/media/icon", &[Get]);
pub const GENUI_MAP: Route = Route::new("genuiMap", "/api/genui/map", &[Get]).as_prefix();
pub const GENUI_GEOCODE: Route = Route::new("genuiGeocode", "/api/genui/geocode", &[Get]);
pub const GENUI_PLACES: Route = Route::new("genuiPlaces", "/api/genui/places", &[Post]);
pub const LOCATION: Route = Route::new("location", "/api/location", &[Get]);
pub const REMOTE_PAIR: Route = Route::new("remotePair", "/api/remote/pair", &[Post]);
pub const REMOTE_STATUS: Route = Route::new("remoteStatus", "/api/remote/status", &[Get]);
pub const REMOTE_ARM: Route = Route::new("remoteArm", "/api/remote/arm", &[Post]);
pub const REMOTE_CONFIG: Route = Route::new("remoteConfig", "/api/remote/config", &[Put]);
pub const HOST_INFO: Route = Route::new("hostInfo", "/api/host", &[Get]);
pub const PEER: Route = Route::new("peer", "/api/peer", &[Get, Put]);
pub const PEER_INVITE: Route = Route::new("peerInvite", "/api/peer/invite", &[Post, Delete]);
pub const PEER_DEVICE: Route = Route::new("peerDevice", "/api/peer/devices/:fp", &[Delete]);
pub const PEER_DEVICE_DISCONNECT: Route =
    Route::new("peerDeviceDisconnect", "/api/peer/devices/:fp/disconnect", &[Post]);
pub const PEER_PAIR: Route = Route::new("peerPair", "/peer/pair", &[Post]);
pub const PEER_REVERSE: Route = Route::new("peerReverse", "/peer/reverse", &[Post]);
pub const HOSTS: Route = Route::new("hosts", "/api/hosts", &[Get, Post]);
pub const HOST: Route = Route::new("host", "/api/hosts/:id", &[Put, Delete]);
pub const HOST_RECONNECT: Route = Route::new("hostReconnect", "/api/hosts/:id/reconnect", &[Post]);
pub const HOST_VIEW_TOKEN: Route = Route::new("hostViewToken", "/api/hosts/:id/view-token", &[Post]);
pub const HOST_PROXY_PREFIX: Route =
    Route::new("hostProxyPrefix", "/h/:id", &[Get, Post, Put, Delete, Head]).as_prefix();
pub const ANTHROPIC_CONFIG: Route = Route::new("anthropicConfig", "/api/anthropic/config", &[Get, Put]);
pub const USAGE: Route = Route::new("usage", "/api/usage", &[Get]);
pub const ARTIFACTS: Route = Route::new("artifacts", "/api/artifacts", &[Get]);
pub const ARTIFACTS_REFRESH: Route = Route::new("artifactsRefresh", "/api/artifacts/refresh", &[Post]);
pub const PLUGINS: Route = Route::new("plugins", "/api/plugins", &[Get]);
pub const PLUGIN: Route = Route::new("plugin", "/api/plugins/:id", &[Get, Delete]).encoding(&["id"]);
pub const PLUGIN_STATUS: Route = Route::new("pluginStatus", "/api/plugins/:id/status", &[Get]).encoding(&["id"]);
pub const PLUGIN_REPORT: Route = Route::new("pluginReport", "/api/plugins/:id/report", &[Post]).encoding(&["id"]);
pub const PLUGIN_ENABLED: Route = Route::new("pluginEnabled", "/api/plugins/:id/enabled", &[Put]).encoding(&["id"]);
pub const PLUGIN_SETTINGS: Route = Route::new("pluginSettings", "/api/plugins/:id/settings", &[Put]).encoding(&["id"]);
pub const PLUGIN_STORE: Route =
    Route::new("pluginStore", "/api/plugins/:id/store/:key", &[Get, Put]).encoding(&["id", "key"]);
pub const PLUGIN_PREVIEW: Route = Route::new("pluginPreview", "/api/plugins/:id/preview", &[Post]).encoding(&["id"]);
pub const PLUGIN_INSTALL: Route = Route::new("pluginInstall", "/api/plugins/install", &[Post]);
pub const PLUGIN_STAGED: Route =
    Route::new("pluginStaged", "/api/plugins/install/:stagingId", &[Post, Delete]).encoding(&["stagingId"]);
pub const PLUGIN_UPDATE: Route = Route::new("pluginUpdate", "/api/plugins/:id/update", &[Post]).encoding(&["id"]);
pub const API_BACKENDS: Route = Route::new("apiBackends", "/api/backends", &[Post]);
pub const API_BACKEND_PRESETS: Route = Route::new("apiBackendPresets", "/api/backends/presets", &[Get]);
pub const API_BACKEND_MODELS: Route = Route::new("apiBackendModels", "/api/backends/:name/models", &[Get]);
pub const API_BACKEND_TEST: Route = Route::new("apiBackendTest", "/api/backends/test", &[Post]);
pub const API_BACKEND_DELETE: Route = Route::new("apiBackendDelete", "/api/backends/:name", &[Delete]);
pub const ACCOUNTS: Route = Route::new("accounts", "/api/accounts", &[Get]);
pub const ACCOUNT_SIGN_IN: Route = Route::new("accountSignIn", "/api/accounts/:provider/sign-in", &[Post, Delete]);
pub const ACCOUNT_LOGIN: Route = Route::new("accountLogin", "/api/accounts/:provider/logins/:id", &[Put, Delete]);
pub const ACCOUNT_DEFAULT_LOGIN: Route =
    Route::new("accountDefaultLogin", "/api/accounts/:provider/default-login", &[Put]);
pub const ACCOUNT_AUTO_SWITCH: Route = Route::new("accountAutoSwitch", "/api/accounts/:provider/auto-switch", &[Put]);
pub const WORKER_PLAN_RESUME: Route = Route::new("workerPlanResume", "/workers/:id/plan-resume", &[Put]);
pub const WORKER_API_KEY_CONTINUE: Route = Route::new("workerApiKeyContinue", "/workers/:id/api-key-continue", &[Post]);
pub const SIGN_IN: Route = Route::new("signIn", "/api/sign-ins/:id", &[Get, Delete]);
pub const SIGN_IN_CODE: Route = Route::new("signInCode", "/api/sign-ins/:id/code", &[Post]);
pub const BROWSER_STATUS: Route = Route::new("browserStatus", "/browser/status", &[Get]);
pub const BROWSER_LAUNCH: Route = Route::new("browserLaunch", "/browser/launch", &[Post]);
pub const BROWSER_TABS: Route = Route::new("browserTabs", "/browser/tabs", &[Get, Post]);
pub const BROWSER_ACTIVE_TAB: Route = Route::new("browserActiveTab", "/browser/active-tab", &[Get]);
pub const BROWSER_SHOW: Route = Route::new("browserShow", "/browser/show", &[Post]);
pub const BROWSER_TAB: Route = Route::new("browserTab", "/browser/tabs/:tabId", &[Delete]);
pub const BROWSER_NAVIGATE: Route = Route::new("browserNavigate", "/browser/tabs/:tabId/navigate", &[Post]);
pub const BROWSER_SNAPSHOT: Route = Route::new("browserSnapshot", "/browser/tabs/:tabId/snapshot", &[Post]);
pub const BROWSER_FIND: Route = Route::new("browserFind", "/browser/tabs/:tabId/find", &[Post]);
pub const BROWSER_WAIT: Route = Route::new("browserWait", "/browser/tabs/:tabId/wait", &[Post]);
pub const BROWSER_ACT: Route = Route::new("browserAct", "/browser/tabs/:tabId/act", &[Post]);
pub const BROWSER_GET: Route = Route::new("browserGet", "/browser/tabs/:tabId/get", &[Post]);
pub const BROWSER_CAPTURE: Route = Route::new("browserCapture", "/browser/tabs/:tabId/capture", &[Post]);
pub const BROWSER_DEVICE: Route = Route::new("browserDevice", "/browser/tabs/:tabId/device", &[Post]);
pub const BROWSER_ELEMENTS: Route = Route::new("browserElements", "/browser/tabs/:tabId/elements", &[Post]);
pub const BROWSER_MUTE: Route = Route::new("browserMute", "/browser/tabs/:tabId/mute", &[Post]);

/// Every route, in the order of `ROUTES`.
pub const ROUTES: &[Route] = &[
    HEALTH,
    STREAM,
    STREAM_FOCUS,
    WORKERS,
    WORKERS_ARCHIVED,
    WORKERS_ARCHIVED_APP_CLOSED,
    WORKER,
    WORKER_EVENTS,
    WORKER_ATTACHMENTS,
    WORKER_PROMPT_EVENTS,
    WORKER_SUBAGENT_EVENTS,
    WORKER_WORKFLOW_RUNS,
    WORKER_WORKFLOW_RUN,
    WORKER_WORKFLOW_RUN_STOP,
    WORKER_WORKFLOW_AGENT,
    WORKER_SIDE_QUESTION,
    WORKER_MESSAGE,
    WORKER_WARM,
    WORKER_QUEUE,
    WORKER_QUEUE_ITEM,
    WORKER_ACTION,
    WORKER_PUSH,
    WORKER_PUSH_STATE,
    WORKER_PULL,
    ORCHESTRATORS,
    ORCHESTRATOR_MESSAGE,
    ORCHESTRATOR_INTEGRATE,
    ORCHESTRATOR_LOOP,
    ORCHESTRATOR_LOOP_STOP,
    POLICY_DECIDE,
    POLICY_RULE,
    PENDING,
    PENDING_DECISION,
    METRICS,
    DATETIME,
    UI_CONFIG,
    MODEL_CATALOG_REFRESH,
    PICK_DIRECTORY,
    PICK_FILE,
    FS_DEFAULT_APP,
    FS_OPEN,
    FS_ICON,
    FS_BRANCHES,
    FS_UNPUSHED,
    FS_COMMIT,
    FS_LOG,
    FS_CHANGES,
    FS_CHANGES_FILE,
    FS_BLOB,
    FS_STASHES,
    FS_STASH_APPLY,
    FS_STASH_DROP,
    FS_RECENTS,
    FS_RECENTS_REMOVE,
    PROJECTS,
    PROJECTS_DELETE,
    FS_REVEAL,
    FS_OPEN_IN,
    FS_EDITORS,
    FS_READ,
    FS_LIST,
    FS_IMAGE,
    FS_RAW,
    PDFJS,
    FS_CHECKOUT,
    FS_BRANCH_CREATE,
    FS_BRANCH_RENAME,
    FS_BRANCH_DELETE,
    FS_FETCH,
    FS_REMOTE_BRANCH_DELETE,
    FS_WRITE,
    FS_PASTE,
    FS_PASTE_B64,
    FS_STAT,
    FS_CREATE,
    FS_RENAME,
    FS_MOVE,
    FS_TRASH,
    FS_WATCH,
    FS_UNWATCH,
    FS_GIT_WATCH,
    FS_GIT_UNWATCH,
    SYMBOLS_LOOKUP,
    SYMBOLS_SEARCH,
    SYMBOLS_FILE,
    WORKER_NAME,
    WORKER_RENAME_INTENT,
    WORKER_OPEN,
    WORKER_PERMISSION,
    WORKER_MODEL,
    WORKER_BACKEND,
    WORKER_DIFF,
    WORKER_CHANGES,
    WORKER_FILE_DIFF,
    WORKER_CHANGES_DISCARD,
    WORKER_CONFLICTS,
    WORKER_CONFLICT_FILE,
    WORKER_CONFLICT_RESOLVE,
    WORKER_MEMORY,
    WORKER_MEMORY_ITEM,
    WORKER_INTERRUPT,
    WORKER_RESUME,
    WORKER_ARCHIVE,
    WORKER_RESTORE,
    WORKER_PURGE,
    WORKER_KEYSTROKE,
    WORKER_QUESTION,
    WORKER_QUESTION_POLL,
    WORKER_QUESTION_ANSWER,
    WORKER_PEERS,
    WORKER_PEER_REQUEST,
    WORKER_PEER_REQUEST_POLL,
    WORKER_PEER_RESPONSE,
    WORKER_NOTIFY,
    WORKER_REPORT,
    WORKER_REWIND_TARGETS,
    WORKER_REWIND,
    WORKER_TERMINAL,
    TERMINAL,
    TERMINAL_KILL,
    PTY,
    PTY_SESSION,
    PTY_INPUT,
    PTY_RESIZE,
    PTY_BUFFER,
    PTY_CONVERSATION,
    PTY_MESSAGE,
    PTY_ANSWER,
    WORKER_TRY_PREVIEW,
    WORKER_TRY_STATE,
    WORKER_TRY,
    WORKER_TRY_KEEP,
    WORKER_TRY_DISCARD,
    COMMANDS,
    TEMPLATES,
    TEMPLATE,
    PAGES,
    PAGE,
    PAGE_EDIT,
    PROFILE,
    PROFILE_PREVIEW,
    PROFILE_AVATAR,
    PROFILE_IMPORT_CLAUDE_MD,
    USER_MEMORIES,
    USER_MEMORY,
    USER_MEMORY_APPROVE,
    USER_MEMORY_DISMISS,
    USER_MEMORIES_APPROVE_ALL,
    USER_MEMORY_SUGGEST,
    USER_MEMORY_SEARCH,
    JOBS,
    JOBS_CLEAR,
    JOB_OUTPUT,
    JOB_STOP,
    JOB_DISMISS,
    UPDATE,
    UPDATE_CHECK,
    UPDATE_DOWNLOAD,
    UPDATE_RESTART,
    UPDATE_LATER,
    UPDATE_DISMISS,
    SETTINGS_UPDATES,
    DREAMS,
    DREAM,
    DREAM_STATUS,
    DREAM_STOP,
    DREAM_EXCLUSIONS,
    SYNC,
    SYNC_CREATE,
    SYNC_JOIN,
    SYNC_KEY,
    SYNC_NOW,
    SYNC_LEAVE,
    TRANSFER_LIST,
    TRANSFER_SCAN,
    TRANSFER_READ,
    TRANSFER_WRITE,
    TRANSFER_PREPARE,
    TRANSFER_COMMIT,
    TRANSFER_ABORT,
    TRANSFER_KEY,
    TRANSFER_LOCATE,
    TRANSFERS,
    TRANSFER_DESTINATION,
    TRANSFER_PAUSE,
    TRANSFER_RESUME,
    TRANSFER_CANCEL,
    TRANSFER_DECIDE,
    WORKER_TRANSFERS,
    WORKER_TRANSFER,
    PROMPTS,
    PROMPT_PREVIEW,
    WORKER_EXPORT,
    WORKER_DEFINITIONS,
    SETTINGS,
    SETTINGS_ARCHIVE,
    SETTINGS_COMPACTION,
    SETTINGS_GENUI,
    GENUI_VIEWS,
    GENUI_VIEW,
    GENUI_VIEW_STATE,
    GENUI_APPS,
    GENUI_MEDIA_IMG,
    GENUI_MEDIA_OG,
    GENUI_MEDIA_ICON,
    GENUI_MAP,
    GENUI_GEOCODE,
    GENUI_PLACES,
    LOCATION,
    REMOTE_PAIR,
    REMOTE_STATUS,
    REMOTE_ARM,
    REMOTE_CONFIG,
    HOST_INFO,
    PEER,
    PEER_INVITE,
    PEER_DEVICE,
    PEER_DEVICE_DISCONNECT,
    PEER_PAIR,
    PEER_REVERSE,
    HOSTS,
    HOST,
    HOST_RECONNECT,
    HOST_VIEW_TOKEN,
    HOST_PROXY_PREFIX,
    ANTHROPIC_CONFIG,
    USAGE,
    ARTIFACTS,
    ARTIFACTS_REFRESH,
    PLUGINS,
    PLUGIN,
    PLUGIN_STATUS,
    PLUGIN_REPORT,
    PLUGIN_ENABLED,
    PLUGIN_SETTINGS,
    PLUGIN_STORE,
    PLUGIN_PREVIEW,
    PLUGIN_INSTALL,
    PLUGIN_STAGED,
    PLUGIN_UPDATE,
    API_BACKENDS,
    API_BACKEND_PRESETS,
    API_BACKEND_MODELS,
    API_BACKEND_TEST,
    API_BACKEND_DELETE,
    ACCOUNTS,
    ACCOUNT_SIGN_IN,
    ACCOUNT_LOGIN,
    ACCOUNT_DEFAULT_LOGIN,
    ACCOUNT_AUTO_SWITCH,
    WORKER_PLAN_RESUME,
    WORKER_API_KEY_CONTINUE,
    SIGN_IN,
    SIGN_IN_CODE,
    BROWSER_STATUS,
    BROWSER_LAUNCH,
    BROWSER_TABS,
    BROWSER_ACTIVE_TAB,
    BROWSER_SHOW,
    BROWSER_TAB,
    BROWSER_NAVIGATE,
    BROWSER_SNAPSHOT,
    BROWSER_FIND,
    BROWSER_WAIT,
    BROWSER_ACT,
    BROWSER_GET,
    BROWSER_CAPTURE,
    BROWSER_DEVICE,
    BROWSER_ELEMENTS,
    BROWSER_MUTE,
];
