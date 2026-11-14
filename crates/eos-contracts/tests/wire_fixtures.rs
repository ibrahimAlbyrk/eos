//! Recorded wire against the types: every response body, stream payload and
//! request body the wire recorder captured from the Node daemon
//! (`fixtures/wire/recordings`) goes through the type its route uses and
//! must come back as equal JSON; a recorded `invalid request: …` answer must
//! be refused here with the same words.
//!
//! Skipped while the fixtures are not in the tree (`EOS_WIRE_FIXTURES` points
//! at a copy elsewhere).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use common::{decode, run};
use serde_json::Value;

/// `<METHOD> <route template>` → the schema of its success body. A trailing
/// `[]` means the body is a list of that schema.
const RESPONSES: &[(&str, &str)] = &[
    ("GET /health", "HealthResponseSchema"),
    ("GET /datetime", "CurrentDateTimeResponseSchema"),
    ("GET /workers", "WorkerListResponseSchema"),
    ("GET /workers/archived", "WorkerListResponseSchema"),
    ("GET /orchestrators", "OrchestratorListResponseSchema"),
    ("GET /workers/:id", "WorkerRowSchema"),
    ("GET /workers/:id/events", "WorkerEventRowSchema[]"),
    ("GET /workers/:id/prompt-events", "WorkerEventRowSchema[]"),
    ("GET /workers/:id/subagent-events", "WorkerEventRowSchema[]"),
    ("GET /workers/:id/attachments", "WorkerAttachmentsResponseSchema"),
    ("GET /workers/:id/queue", "WorkerQueueResponseSchema"),
    ("GET /workers/:id/peers", "PeerListResponseSchema"),
    ("GET /workers/:id/memory", "MemoryListResponseSchema"),
    ("GET /workers/:id/workflow-runs", "WorkflowRunListSchema"),
    ("GET /workers/:id/changes", "WorkerChangesResponseSchema"),
    ("GET /workers/:id/changes/file", "FileDiffResponseSchema"),
    ("GET /workers/:id/diff", "WorkerDiffResponseSchema"),
    ("GET /workers/:id/push-state", "PushStateResponseSchema"),
    ("GET /workers/:id/conflicts", "ConflictListResponseSchema"),
    ("GET /workers/:id/try/state", "TryStateResponseSchema"),
    ("GET /workers/:id/question/:questionId", "QuestionPollResponseSchema"),
    ("GET /workers/:fromWorker/peer-request/:requestId", "PeerRequestPollResponseSchema"),
    ("POST /workers/:id/question", "QuestionRegisterResponseSchema"),
    ("POST /workers/:id/peer-response", "PeerResponseResultSchema"),
    ("POST /workers/:id/changes/discard", "WorkerChangesDiscardResponseSchema"),
    ("POST /workers/:id/terminal", "TerminalRunResponseSchema"),
    ("PUT /workers/:id/model", "SetModelResponseSchema"),
    ("PUT /workers/:id/permission", "SetPermissionResponseSchema"),
    ("DELETE /workers/:id/memory/:name", "MemoryMutationResponseSchema"),
    ("GET /pending", "PendingListResponseSchema"),
    ("POST /policy/decide", "PolicyDecideResponseSchema"),
    ("POST /api/policy/rule", "PolicyRuleResponseSchema"),
    ("GET /api/ui-config", "UiConfigResponseSchema"),
    ("GET /api/jobs", "BackgroundJobListSchema"),
    ("GET /api/jobs/:id/output", "BackgroundJobOutputSchema"),
    ("GET /fs/stat", "FsStatResponseSchema"),
    ("GET /fs/list", "FsListResponseSchema"),
    ("GET /fs/read", "FsReadResponseSchema"),
    ("GET /fs/default-app", "DefaultAppResponseSchema"),
    ("GET /fs/recents", "RecentsResponseSchema"),
    ("GET /fs/branches", "BranchesResponseSchema"),
    ("GET /fs/unpushed", "UnpushedResponseSchema"),
    ("GET /fs/log", "FsLogResponseSchema"),
    ("GET /fs/commit", "CommitDetailSchema"),
    ("GET /fs/changes", "FsChangesResponseSchema"),
    ("GET /fs/changes/file", "FileDiffResponseSchema"),
    ("GET /fs/stashes", "FsStashesResponseSchema"),
    ("POST /fs/branch/create", "BranchOpResponseSchema"),
    ("POST /fs/branch/rename", "BranchOpResponseSchema"),
    ("POST /fs/branch/delete", "BranchDeleteResponseSchema"),
    ("POST /fs/checkout", "FsCheckoutResponseSchema"),
    ("POST /fs/fetch", "FetchResponseSchema"),
    ("POST /fs/remote-branch/delete", "RemoteBranchDeleteResponseSchema"),
    ("POST /fs/create", "FsMutationResponseSchema"),
    ("POST /fs/rename", "FsMutationResponseSchema"),
    ("POST /fs/move", "FsMoveResponseSchema"),
    ("POST /fs/watch", "FsWatchResponseSchema"),
    ("GET /projects", "ProjectsResponseSchema"),
    ("GET /symbols/file", "SymbolsFileResponseSchema"),
    ("GET /symbols/lookup", "SymbolsLookupResponseSchema"),
    ("GET /symbols/search", "SymbolsSearchResponseSchema"),
    ("GET /commands", "CommandsResponseSchema"),
    ("GET /api/templates", "TemplateListResponseSchema"),
    ("POST /api/templates", "TemplateMutationResponseSchema"),
    ("PUT /api/templates/:name", "TemplateMutationResponseSchema"),
    ("DELETE /api/templates/:name", "TemplateMutationResponseSchema"),
    ("GET /api/pages", "PageListResponseSchema"),
    ("POST /api/pages", "PageResponseSchema"),
    ("GET /api/pages/:id", "PageResponseSchema"),
    ("PUT /api/pages/:id", "PageResponseSchema"),
    ("POST /api/pages/:id/edit", "PageResponseSchema"),
    ("GET /api/profile", "UserProfileResponseSchema"),
    ("PUT /api/profile", "UserProfileResponseSchema"),
    ("PUT /api/profile/avatar", "UserProfileResponseSchema"),
    ("DELETE /api/profile/avatar", "UserProfileResponseSchema"),
    ("GET /api/profile/preview", "UserProfilePreviewSchema"),
    ("GET /api/profile/import/claude-md", "ClaudeMdImportResponseSchema"),
    ("GET /api/user-memories", "UserMemoryListResponseSchema"),
    ("GET /api/user-memories/search", "UserMemoryListResponseSchema"),
    ("POST /api/user-memories/approve-all", "UserMemoryListResponseSchema"),
    ("POST /api/user-memories", "UserMemoryResponseSchema"),
    ("PUT /api/user-memories/:id", "UserMemoryResponseSchema"),
    ("POST /api/user-memories/:id/approve", "UserMemoryResponseSchema"),
    ("POST /api/user-memories/suggest", "UserMemorySuggestResponseSchema"),
    ("GET /api/settings", "SettingsResponseSchema"),
    ("PUT /api/settings", "SettingsResponseSchema"),
    ("GET /api/settings/genui", "GenuiSettingsSchema"),
    ("PUT /api/settings/genui", "GenuiSettingsSchema"),
    ("GET /api/anthropic/config", "AnthropicConfigStatusSchema"),
    ("PUT /api/anthropic/config", "AnthropicConfigStatusSchema"),
    ("GET /api/backends/presets", "BackendPresetsResponseSchema"),
    ("GET /api/backends/:name/models", "BackendModelsResponseSchema"),
    ("GET /api/prompts", "PromptCatalogResponseSchema"),
    ("POST /api/prompts/preview", "PromptPreviewResponseSchema"),
    ("GET /worker-definitions", "WorkerDefinitionListResponseSchema"),
    ("POST /worker-definitions", "CreateWorkerResponseSchema"),
    ("GET /api/accounts", "AccountsResponseSchema"),
    ("GET /api/usage", "UsageResponseSchema"),
    ("GET /api/artifacts", "ArtifactCatalogSchema"),
    ("POST /api/artifacts/refresh", "ArtifactCatalogSchema"),
    ("GET /api/update", "UpdateStateSchema"),
    ("POST /api/update/check", "UpdateStateSchema"),
    ("POST /api/update/download", "UpdateStateSchema"),
    ("POST /api/update/later", "UpdateStateSchema"),
    ("POST /api/update/dismiss", "UpdateStateSchema"),
    ("PUT /api/settings/updates", "UpdateStateSchema"),
    ("GET /api/sync", "SyncStatusResponseSchema"),
    ("POST /api/sync/now", "SyncStatusResponseSchema"),
    ("POST /api/sync/leave", "SyncStatusResponseSchema"),
    ("GET /api/transfers", "TransferListResponseSchema"),
    ("GET /transfer/list", "TransferListingSchema"),
    ("POST /transfer/scan", "TransferManifestSchema"),
    ("POST /transfer/prepare", "TransferPrepareResultSchema"),
    ("POST /transfer/commit", "TransferCommitResultSchema"),
    ("POST /transfer/key", "TransferKeyResponseSchema"),
    ("POST /transfer/locate", "TransferLocateResponseSchema"),
    ("GET /api/dreams", "DreamListResponseSchema"),
    ("GET /api/dreams/status", "DreamStatusSchema"),
    ("GET /api/host", "HostInfoSchema"),
    ("GET /api/peer", "PeerStatusSchema"),
    ("PUT /api/peer", "PeerStatusSchema"),
    ("GET /browser/status", "BrowserStatusSchema"),
    ("GET /browser/tabs", "BrowserTabsResponseSchema"),
    ("POST /stream/focus", "StreamFocusResponseSchema"),
    ("POST /terminal", "TerminalRunResponseSchema"),
    ("GET /pty", "PtyListResponseSchema"),
    ("POST /pty", "PtyCreateResponseSchema"),
    ("GET /pty/:id/buffer", "PtyBufferResponseSchema"),
    ("POST /api/genui/views", "CreateViewResponseSchema"),
    ("POST /api/genui/apps", "CreateAppResponseSchema"),
    ("GET /api/genui/views/:id", "ViewRecordSchema"),
    ("GET /api/genui/views/:id/state", "ViewStateResponseSchema"),
    ("PUT /api/genui/views/:id/state", "ViewStateResponseSchema"),
];

/// Route → the schema its request body (or query string) is checked against.
const REQUESTS: &[(&str, &str)] = &[
    ("GET /workers/:id/events", "EventsQuerySchema"),
    ("GET /fs/branches", "BranchesQuerySchema"),
    ("GET /fs/log", "FsLogQuerySchema"),
    ("GET /fs/list", "FsListQuerySchema"),
    ("GET /fs/read", "FsReadQuerySchema"),
    ("GET /fs/stat", "FsStatQuerySchema"),
    ("GET /fs/changes", "FsChangesQuerySchema"),
    ("GET /fs/changes/file", "FsChangesFileQuerySchema"),
    ("GET /fs/stashes", "FsStashesQuerySchema"),
    ("GET /symbols/lookup", "SymbolsLookupQuerySchema"),
    ("GET /symbols/search", "SymbolsSearchQuerySchema"),
    ("GET /symbols/file", "SymbolsFileQuerySchema"),
    ("GET /commands", "CommandsQuerySchema"),
    ("POST /workers/:id/message", "MessageRequestSchema"),
    ("POST /orchestrators/:id/message", "MessageRequestSchema"),
    ("POST /workers", "SpawnWorkerRequestSchema"),
    ("POST /orchestrators", "SpawnOrchestratorRequestSchema"),
    ("PUT /workers/:id/name", "SetNameRequestSchema"),
    ("PUT /workers/:id/model", "SetModelRequestSchema"),
    ("PUT /workers/:id/permission", "SetPermissionRequestSchema"),
    ("POST /workers/:id/notify", "NotifyRequestSchema"),
    ("POST /workers/:id/btw", "SideQuestionRequestSchema"),
    ("POST /policy/decide", "PolicyDecideRequestSchema"),
    ("POST /pending/:id/decision", "PendingDecisionRequestSchema"),
    ("POST /api/pages", "PageCreateRequestSchema"),
    ("PUT /api/pages/:id", "PageUpdateRequestSchema"),
    ("POST /api/pages/:id/edit", "PageEditRequestSchema"),
    ("PUT /api/profile", "UserProfileUpdateRequestSchema"),
    ("POST /api/user-memories", "UserMemoryCreateRequestSchema"),
    ("PUT /api/user-memories/:id", "UserMemoryUpdateRequestSchema"),
    ("POST /api/user-memories/suggest", "UserMemorySuggestRequestSchema"),
    ("POST /api/templates", "TemplateCreateRequestSchema"),
    ("PUT /api/templates/:name", "TemplateUpdateRequestSchema"),
    ("POST /api/prompts/preview", "PromptPreviewRequestSchema"),
    ("POST /worker-definitions", "CreateWorkerRequestSchema"),
    ("PUT /api/accounts/:provider/auto-switch", "AutoSwitchRequestSchema"),
    ("POST /api/update/check", "UpdateCheckRequestSchema"),
    ("PUT /api/settings/updates", "UpdateSettingsPatchSchema"),
    ("POST /api/sync/join", "SyncJoinRequestSchema"),
    ("PUT /api/plugins/:id/enabled", "PluginEnabledRequestSchema"),
    ("PUT /api/plugins/:id/settings", "PluginSettingsRequestSchema"),
    ("POST /api/plugins/:id/report", "PluginReportRequestSchema"),
    ("POST /api/plugins/install", "PluginInstallStageRequestSchema"),
    ("POST /terminal", "WorkspaceTerminalRunRequestSchema"),
    ("POST /workers/:id/terminal", "TerminalRunRequestSchema"),
    ("POST /pty", "PtyCreateRequestSchema"),
    ("POST /pty/:id/input", "PtyInputRequestSchema"),
    ("POST /pty/:id/resize", "PtyResizeRequestSchema"),
    ("PUT /api/genui/views/:id/state", "PutViewStateRequestSchema"),
    ("POST /transfer/scan", "TransferScanRequestSchema"),
    ("POST /transfer/prepare", "TransferPrepareRequestSchema"),
    ("POST /transfer/commit", "TransferCommitRequestSchema"),
    ("POST /transfer/abort", "TransferAbortRequestSchema"),
    ("POST /fs/write", "FsWriteRequestSchema"),
    ("POST /fs/create", "FsCreateRequestSchema"),
    ("POST /fs/rename", "FsRenameRequestSchema"),
    ("POST /fs/move", "FsMoveRequestSchema"),
    ("POST /fs/checkout", "FsCheckoutRequestSchema"),
    ("POST /fs/branch/create", "BranchCreateRequestSchema"),
    ("POST /fs/branch/rename", "BranchRenameRequestSchema"),
    ("POST /fs/branch/delete", "BranchDeleteRequestSchema"),
    ("POST /fs/fetch", "FetchRequestSchema"),
    ("POST /fs/stash/apply", "FsStashApplyRequestSchema"),
    ("POST /fs/stash/drop", "FsStashDropRequestSchema"),
];

/// Bus topic (`reason` of a `change` frame) → the schema of its payload.
const TOPICS: &[(&str, &str)] = &[
    ("fs:change", "FsChangeEventSchema"),
    ("profile:change", "UserProfileChangeEventSchema"),
    ("pages:change", "PageChangeEventSchema"),
    ("user-memory:change", "UserMemoryChangeEventSchema"),
    ("jobs:change", "BackgroundJobChangeSchema"),
    ("genui:change", "GenuiChangeSchema"),
    ("pty:session", "PtySessionSchema"),
];

fn fixtures() -> Option<PathBuf> {
    let dir = std::env::var_os("EOS_WIRE_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire"));
    dir.join("recordings").is_dir().then_some(dir)
}

/// The recorder replaces values that change per run with `<name>` or
/// `<name:n>` (`normalize.toml`). Returns a value of the kind the placeholder
/// stands for, so a typed field accepts it.
fn stand_in(placeholder: &str, number: bool) -> Option<Value> {
    let inner = placeholder.strip_prefix('<')?.strip_suffix('>')?;
    if number {
        return Some(if inner == "now" { Value::from(1_700_000_000_000_i64) } else { Value::from(7) });
    }
    let (kind, n) = inner.split_once(':').unwrap_or((inner, "1"));
    Some(Value::from(match kind {
        "host-id" | "fingerprint" => "0".repeat(64),
        "page" => format!("pg-0000000{n}"),
        "memory" => format!("um-0000000{n}"),
        "view" => format!("v_00000000000{n}"),
        "uuid" => format!("00000000-0000-4000-8000-00000000000{n}"),
        _ => return None,
    }))
}

/// Where two JSON values differ, as `path: wire → rust`.
fn differences(wire: &Value, rust: &Value, path: String, out: &mut Vec<String>) {
    if wire == rust || out.len() >= 8 {
        return;
    }
    match (wire, rust) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                let (x, y) = (a.get(key).unwrap_or(&Value::Null), b.get(key).unwrap_or(&Value::Null));
                if a.contains_key(key) != b.contains_key(key) {
                    out.push(format!(
                        "{path}.{key}: {} on the wire only",
                        if a.contains_key(key) { "present" } else { "absent" }
                    ));
                } else {
                    differences(x, y, format!("{path}.{key}"), out);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            a.iter().zip(b).enumerate().for_each(|(i, (x, y))| differences(x, y, format!("{path}.{i}"), out));
        }
        _ => out.push(format!("{path}: {wire} → {rust}")),
    }
}

/// The request could not be rebuilt: a scenario value stands where a typed one is needed.
const UNRESOLVED: &str = "unresolved scenario value";

fn stamp_numbers(v: &mut Value) {
    match v {
        Value::String(s) if s == "<now>" => *v = Value::from(1_700_000_000_000_i64),
        Value::Array(a) => a.iter_mut().for_each(stamp_numbers),
        Value::Object(o) => o.values_mut().for_each(stamp_numbers),
        _ => {}
    }
}

fn at_path<'a>(v: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    path.iter().try_fold(v, |v, seg| match v {
        Value::Array(a) => a.get_mut(seg.parse::<usize>().ok()?),
        Value::Object(o) => o.get_mut(seg),
        _ => None,
    })
}

/// Parses `body` as `schema`, swapping in a stand-in wherever a placeholder
/// sits in a typed field. Returns the body as finally parsed and the outcome.
type Parse = fn(&str, &Value) -> Option<Result<Value, eos_contracts::ValidationError>>;

fn run_normalized(parse: Parse, schema: &str, mut body: Value) -> (Value, Result<Value, String>) {
    for _ in 0..2000 {
        match parse(schema, &body).unwrap_or_else(|| panic!("no Rust type for {schema}")) {
            Ok(out) => return (body, Ok(out)),
            Err(e) => {
                let issue = &e.issues[0];
                let number =
                    issue.message.starts_with("Expected number") || issue.message.starts_with("Expected integer");
                let abs_path = issue.message == "absolute path required";
                let swapped = at_path(&mut body, &issue.path).and_then(|slot| {
                    let text = slot.as_str()?;
                    // `{name}` is a value of the scenario the recorder filled in at run time.
                    let new = match text.strip_prefix('{') {
                        Some(_) if number => Value::from(7),
                        Some(_) if abs_path => Value::from(format!("/{text}")),
                        Some(_) => return None,
                        None => stand_in(text, number)?,
                    };
                    *slot = new;
                    Some(())
                });
                if swapped.is_none() {
                    // A tagged union hides the path: fall back to every run-time stamp at once.
                    let before = body.clone();
                    if number {
                        stamp_numbers(&mut body);
                    }
                    if body == before {
                        let unresolved = at_path(&mut body, &issue.path)
                            .and_then(|v| v.as_str().map(|t| t.starts_with('{')))
                            == Some(true);
                        return (body, Err(if unresolved { UNRESOLVED.to_owned() } else { e.message() }));
                    }
                }
            }
        }
    }
    (body, Err("too many placeholders".to_owned()))
}

fn round_trip(schema: &str, body: &Value) -> Result<(), String> {
    if let Some(item) = schema.strip_suffix("[]") {
        let list = body.as_array().ok_or("not a list")?;
        return list
            .iter()
            .enumerate()
            .try_for_each(|(i, row)| round_trip(item, row).map_err(|e| format!("[{i}] {e}")));
    }
    // A response is not checked like a request: the daemon never validated what it sent.
    let (sent, out) = run_normalized(decode, schema, body.clone());
    let out = out?;
    if out == sent {
        return Ok(());
    }
    let mut where_ = Vec::new();
    differences(&sent, &out, String::new(), &mut where_);
    Err(format!("writes back differently at {}", where_.join(", ")))
}

/// Known difference: for a bad union tag Zod says `Invalid discriminator
/// value. Expected 'a' | 'b'`; serde reports it like any enum (`Invalid enum
/// value. Expected 'a' | 'b', received 'x'`).
fn as_enum_issue(issue: &str) -> String {
    issue.replace("Invalid discriminator value. Expected", "Invalid enum value. Expected")
}

#[test]
fn recorded_wire_goes_through_the_types_unchanged() {
    let Some(dir) = fixtures() else {
        eprintln!("skipped: no wire fixtures in this tree yet");
        return;
    };
    let responses: BTreeMap<_, _> = RESPONSES.iter().copied().collect();
    let requests: BTreeMap<_, _> = REQUESTS.iter().copied().collect();
    let topics: BTreeMap<_, _> = TOPICS.iter().copied().collect();
    let mut failures = Vec::new();
    let mut unmapped = BTreeSet::new();
    let (mut bodies, mut frames, mut refusals, mut accepted, mut errors) = (0, 0, 0, 0, 0);

    let mut files: Vec<_> = std::fs::read_dir(dir.join("recordings")).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for file in files {
        let recording: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        for exchange in recording["exchanges"].as_array().unwrap() {
            let step = &exchange["step"];
            let response = &exchange["response"];
            let at =
                format!("{} › {}", file.file_name().unwrap().to_string_lossy(), step["name"].as_str().unwrap_or("?"));
            let route = exchange["route"].as_str().unwrap_or("");
            let status = response["status"].as_u64().unwrap_or(0);

            if let Some(json) = response.get("json") {
                if (200..300).contains(&status) {
                    match responses.get(route) {
                        Some(schema) => {
                            bodies += 1;
                            if let Err(e) = round_trip(schema, json) {
                                failures.push(format!("{at}: {route} as {schema}: {e}"));
                            }
                        }
                        None => {
                            unmapped.insert(route.to_owned());
                        }
                    }
                } else if json.get("error").is_some_and(Value::is_string) {
                    errors += 1;
                    if let Err(e) = round_trip("ErrorResponseSchema", json) {
                        failures.push(format!("{at}: error body: {e}"));
                    }
                }
            }

            // A step without a request joins an earlier one; its body was checked there.
            if let (Some(schema), true) = (requests.get(route), step.get("request").is_some()) {
                // A GET is checked on its query parameters, which arrive as text.
                let input = match step.get("body") {
                    Some(body) if !body.is_null() => body.clone(),
                    _ => step.get("query").cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new())),
                };
                let (_, ours) = run_normalized(run, schema, input);
                let theirs = response["json"]["error"].as_str().and_then(|e| e.strip_prefix("invalid request: "));
                // An issue with no path on a body we accept is the route checking its path parameter.
                let theirs = theirs.filter(|t| !(t.starts_with(": invalid ") && t.ends_with(" id")));
                match (ours, theirs) {
                    (Err(ours), _) if ours == UNRESOLVED => {}
                    (Err(ours), Some(theirs)) => {
                        refusals += 1;
                        // serde stops at the first type error; Zod lists every issue.
                        let ours = ours.strip_prefix("invalid request: ").unwrap_or(&ours);
                        let known: Vec<String> = theirs.split("; ").map(as_enum_issue).collect();
                        if !ours.split("; ").all(|issue| known.iter().any(|k| issue.starts_with(k.as_str()))) {
                            failures.push(format!(
                                "{at}: {route} refused differently\n      wire: {theirs}\n      rust: {ours}"
                            ));
                        }
                    }
                    (Ok(_), Some(theirs)) => {
                        failures.push(format!("{at}: {route} accepted, the daemon said: {theirs}"))
                    }
                    (Err(ours), None) if (200..300).contains(&status) => {
                        failures.push(format!("{at}: {route} refused a body the daemon took: {ours}"))
                    }
                    (Ok(_), None) if (200..300).contains(&status) => accepted += 1,
                    _ => {}
                }
            }

            for frame in response["frames"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .filter_map(Value::as_array)
                .flatten()
            {
                if frame["event"] != "change" {
                    continue;
                }
                let reason = frame["data"]["reason"].as_str().unwrap_or("");
                if let (Some(schema), Some(payload)) = (topics.get(reason), frame["data"].get("payload")) {
                    frames += 1;
                    if let Err(e) = round_trip(schema, payload) {
                        failures.push(format!("{at}: {reason} as {schema}: {e}"));
                    }
                }
            }
        }
    }

    eprintln!(
        "{bodies} response bodies, {errors} error bodies, {frames} stream payloads, {accepted} accepted and {refusals} refused requests; \
         {} recorded routes have no schema in contracts",
        unmapped.len()
    );
    assert!(
        failures.is_empty(),
        "{} failures\n  {}",
        failures.len(),
        failures.iter().take(40).map(|f| f.chars().take(900).collect::<String>()).collect::<Vec<_>>().join("\n  ")
    );
    assert!(bodies > 300 && refusals > 20, "the recordings shrank: {bodies} bodies, {refusals} refusals");
}
