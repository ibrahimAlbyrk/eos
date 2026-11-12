//! Fakes of the ports that reach outside the process.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use eos_contracts::{ActiveTry, TryPreviewResponse, UserSettings};
use eos_contracts::{AllowVariant, CatalogModel, DenyVariant, ExternalDecision, UnknownRecord};
use eos_core::accounts::{PlanFailure, PlanLimits, PlanVerdict, SessionCredential, SessionCredentials};
use eos_core::agent::{
    HostTool, LaunchSpec, ModelCatalog, OneShot, OneShotAnswer, OneShotError, OneShotRequest, PromptAssembler,
    ScratchFolders, SpawnFacts, ToolCaller, ToolDefinition, ToolReply, ToolSets, UserQuestions,
};
use eos_core::git::{
    BranchIntegration, TryApplied, TryDiscarded, TrySync, WorktreeCreate, WorktreeCreated, WorktreeEntry,
    WorktreeManager, WorktreeRef, WorktreeRemoved,
};
use eos_core::os::{AppInfo, DesktopFiles, Editor, OpenIn};
use eos_core::policy::{PolicyDecider, ToolCall};
use eos_core::store::{RecentFolders, UserSettingsStore};
use eos_core::{BoxFuture, Error};
use eos_domain::WorkerBranch;

/// A model catalog with a fixed list: windows come from it, else from the
/// built-in baseline, exactly as the real catalog answers.
#[derive(Debug, Default)]
pub struct FakeModelCatalog {
    pub models: Vec<CatalogModel>,
}

impl ModelCatalog for FakeModelCatalog {
    fn models(&self) -> Vec<CatalogModel> {
        self.models.clone()
    }

    fn context_window_for(&self, model: Option<&str>) -> i64 {
        eos_domain::model::context_window_for(&self.models, model)
    }
}

/// A policy that allows every tool call except the tools it was told to deny,
/// and remembers what it was asked.
#[derive(Debug, Default)]
pub struct FakePolicy {
    /// Tool names to deny.
    pub deny: Mutex<Vec<String>>,
    pub asked: Mutex<Vec<ToolCall>>,
}

impl PolicyDecider for FakePolicy {
    fn decide(&self, call: ToolCall) -> BoxFuture<'_, Result<ExternalDecision, Error>> {
        let denied = self.deny.lock().expect("deny").contains(&call.tool_name);
        let decision = if denied {
            ExternalDecision::Deny(DenyVariant { message: format!("{} is denied by policy", call.tool_name) })
        } else {
            ExternalDecision::Allow(AllowVariant { updated_input: Some(call.input.clone()), message: None })
        };
        self.asked.lock().expect("asked").push(call);
        Box::pin(std::future::ready(Ok(decision)))
    }
}

/// The accounts feature as the engine sees it: one credential for new
/// sessions, a scripted answer when a credential fails.
#[derive(Debug, Default)]
pub struct FakeCredentials {
    pub new_session: Mutex<Option<SessionCredential>>,
    /// Answers to `failed`, first to last; `Keep` when none is left.
    pub verdicts: Mutex<VecDeque<PlanVerdict>>,
    pub launched: Mutex<Vec<(String, Option<SessionCredential>)>>,
    pub observed: Mutex<Vec<PlanLimits>>,
    pub failures: Mutex<Vec<(String, PlanFailure)>>,
}

impl FakeCredentials {
    /// New sessions run on this API key.
    pub fn with_key(key: &str) -> Self {
        let key = SessionCredential::ApiKey { provider: "anthropic".into(), key: key.into() };
        Self { new_session: Mutex::new(Some(key)), ..Self::default() }
    }
}

impl SessionCredentials for FakeCredentials {
    fn for_new_session<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<SessionCredential>> {
        Box::pin(std::future::ready(self.new_session.lock().expect("credential").clone()))
    }

    fn launched(&self, worker_id: &str, credential: Option<&SessionCredential>) {
        self.launched.lock().expect("launched").push((worker_id.to_owned(), credential.cloned()));
    }

    fn observed(&self, _credential: &SessionCredential, limits: &PlanLimits) {
        self.observed.lock().expect("observed").push(limits.clone());
    }

    fn failed<'a>(&'a self, worker_id: &'a str, failure: &'a PlanFailure) -> BoxFuture<'a, PlanVerdict> {
        self.failures.lock().expect("failures").push((worker_id.to_owned(), failure.clone()));
        let verdict = self.verdicts.lock().expect("verdicts").pop_front().unwrap_or(PlanVerdict::Keep);
        Box::pin(std::future::ready(verdict))
    }
}

/// A tool that answers with who called it and what with.
#[derive(Debug)]
pub struct EchoTool(pub ToolDefinition);

impl EchoTool {
    pub fn named(name: &str) -> Arc<dyn HostTool> {
        Arc::new(Self(ToolDefinition {
            name: name.to_owned(),
            description: "Reports the calling worker.".to_owned(),
            input_schema: serde_json::json!({"type": "object", "properties": {"note": {"type": "string"}}}),
            deferred: false,
            search_hint: None,
            main_agent_only: false,
        }))
    }
}

impl HostTool for EchoTool {
    fn definition(&self) -> &ToolDefinition {
        &self.0
    }

    fn call<'a>(&'a self, caller: ToolCaller<'a>, input: serde_json::Value) -> BoxFuture<'a, ToolReply> {
        let reply = format!("worker={} call={} input={input}", caller.worker_id, caller.call_id);
        Box::pin(std::future::ready(ToolReply::text(reply)))
    }
}

/// The same tools for every session.
#[derive(Default)]
pub struct FakeToolSets(pub Vec<Arc<dyn HostTool>>);

impl std::fmt::Debug for FakeToolSets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.0.iter().map(|t| &t.definition().name)).finish()
    }
}

impl ToolSets for FakeToolSets {
    fn for_session(&self, _spec: &LaunchSpec) -> Vec<Arc<dyn HostTool>> {
        self.0.clone()
    }
}

/// A user who answers every question with the scripted answers, or turns
/// the questions away when there are none.
#[derive(Debug, Default)]
pub struct FakeUser {
    pub answers: Mutex<Option<UnknownRecord>>,
    pub asked: Mutex<Vec<Vec<UnknownRecord>>>,
    /// The tool call each question came with.
    pub calls: Mutex<Vec<Option<String>>>,
}

impl UserQuestions for FakeUser {
    fn ask<'a>(
        &'a self,
        _worker_id: &'a str,
        call_id: Option<&'a str>,
        questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>> {
        self.asked.lock().expect("asked").push(questions);
        self.calls.lock().expect("calls").push(call_id.map(str::to_owned));
        Box::pin(std::future::ready(self.answers.lock().expect("answers").clone()))
    }
}

/// Recent folders kept in memory, most recent first.
#[derive(Debug, Default)]
pub struct FakeRecents(pub Mutex<Vec<String>>);

impl RecentFolders for FakeRecents {
    fn list(&self) -> Vec<String> {
        self.0.lock().expect("recents").clone()
    }

    fn push(&self, path: &str) {
        let mut all = self.0.lock().expect("recents");
        all.retain(|p| p != path);
        all.insert(0, path.to_owned());
    }

    fn remove(&self, path: &str) {
        self.0.lock().expect("recents").retain(|p| p != path);
    }
}

/// The user's settings, in memory.
#[derive(Debug, Default)]
pub struct FakeSettings(pub Mutex<UserSettings>);

impl UserSettingsStore for FakeSettings {
    fn read(&self) -> UserSettings {
        self.0.lock().expect("settings").clone()
    }

    fn patch(&self, partial: UserSettings) -> Result<UserSettings, Error> {
        let mut all = self.0.lock().expect("settings");
        all.extend(partial);
        Ok(all.clone())
    }
}

/// Scratch folders that exist only as a list: `/scratch/<id>`.
#[derive(Debug, Default)]
pub struct FakeScratch {
    pub folders: Mutex<Vec<String>>,
    /// The next create fails.
    pub refuse: Mutex<bool>,
}

impl ScratchFolders for FakeScratch {
    fn create<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        let made = if std::mem::take(&mut *self.refuse.lock().expect("refuse")) {
            Err(Error::Storage("scratch folder: disk full".into()))
        } else {
            let dir = format!("/scratch/{id}");
            self.folders.lock().expect("folders").push(dir.clone());
            Ok(dir)
        };
        Box::pin(std::future::ready(made))
    }

    fn remove<'a>(&'a self, dir: &'a str) -> BoxFuture<'a, ()> {
        self.folders.lock().expect("folders").retain(|d| d != dir);
        Box::pin(std::future::ready(()))
    }

    fn list(&self) -> Vec<String> {
        self.folders.lock().expect("folders").clone()
    }
}

/// Worktrees that exist only as a list of what was asked for: each one
/// "lands" at `<repo>/.eos/worktrees/<branch>`.
#[derive(Debug, Default)]
pub struct FakeWorktrees {
    pub created: Mutex<Vec<WorktreeCreate>>,
    /// The next create is refused with this reason.
    pub refuse: Mutex<Option<String>>,
    /// What `list_worktrees` answers, whatever the repository.
    pub listed: Mutex<Vec<WorktreeEntry>>,
    pub removed: Mutex<Vec<WorktreeRef>>,
}

impl WorktreeManager for FakeWorktrees {
    fn create<'a>(&'a self, input: &'a WorktreeCreate) -> BoxFuture<'a, WorktreeCreated> {
        let outcome = match self.refuse.lock().expect("refuse").take() {
            Some(reason) => WorktreeCreated::Refused { reason },
            None => {
                self.created.lock().expect("created").push(input.clone());
                WorktreeCreated::Created {
                    worktree_dir: input.repo_root.join(".eos/worktrees").join(&input.branch),
                    fork_base_sha: Some("abc1234".into()),
                }
            }
        };
        Box::pin(std::future::ready(outcome))
    }

    fn remove<'a>(&'a self, worktree: &'a WorktreeRef) -> BoxFuture<'a, WorktreeRemoved> {
        self.removed.lock().expect("removed").push(worktree.clone());
        Box::pin(std::future::ready(WorktreeRemoved::Removed))
    }

    fn list_worktrees<'a>(&'a self, _repo_root: &'a std::path::Path) -> BoxFuture<'a, Vec<WorktreeEntry>> {
        Box::pin(std::future::ready(self.listed.lock().expect("listed").clone()))
    }
}

/// Try with no checkout behind it: applies answer with `apply`, and the
/// snapshots settled after a worker is gone are listed as `(repo, worker)`.
#[derive(Debug)]
pub struct FakeTries {
    pub apply: Mutex<TryApplied>,
    pub applied: Mutex<Vec<WorkerBranch>>,
    pub cleaned: Mutex<Vec<(std::path::PathBuf, String)>>,
}

impl Default for FakeTries {
    fn default() -> Self {
        Self {
            apply: Mutex::new(TryApplied::Applied { files: vec!["a.txt".into()], lockfile_changed: false }),
            applied: Mutex::default(),
            cleaned: Mutex::default(),
        }
    }
}

impl BranchIntegration for FakeTries {
    fn preview<'a>(&'a self, _worker: &'a WorkerBranch) -> BoxFuture<'a, TryPreviewResponse> {
        let preview = TryPreviewResponse {
            supported: true,
            ahead: 0,
            behind: 0,
            conflicts: Vec::new(),
            files: Vec::new(),
            lockfile_changed: false,
            active_tries: Vec::new(),
        };
        Box::pin(std::future::ready(preview))
    }

    fn apply<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TryApplied> {
        self.applied.lock().expect("applied").push(worker.clone());
        Box::pin(std::future::ready(self.apply.lock().expect("apply").clone()))
    }

    fn discard<'a>(&'a self, _repo_root: &'a std::path::Path, _worker_id: &'a str) -> BoxFuture<'a, TryDiscarded> {
        Box::pin(std::future::ready(TryDiscarded::Discarded))
    }

    fn keep<'a>(&'a self, _repo_root: &'a std::path::Path, _worker_id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(std::future::ready(true))
    }

    fn active_tries<'a>(&'a self, _repo_root: &'a std::path::Path) -> BoxFuture<'a, Vec<ActiveTry>> {
        Box::pin(std::future::ready(Vec::new()))
    }

    fn was_kept<'a>(&'a self, _repo_root: &'a std::path::Path, _worker_id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(std::future::ready(false))
    }

    fn sync_status<'a>(&'a self, _worker: &'a WorkerBranch) -> BoxFuture<'a, TrySync> {
        Box::pin(std::future::ready(TrySync::default()))
    }

    fn cleanup_snapshot<'a>(&'a self, repo_root: &'a std::path::Path, worker_id: &'a str) -> BoxFuture<'a, ()> {
        self.cleaned.lock().expect("cleaned").push((repo_root.to_owned(), worker_id.to_owned()));
        Box::pin(std::future::ready(()))
    }
}

/// A desktop that opens nothing and lists what it was asked to open, as
/// `<app>: <path>` (`default` for the default app, an editor's id otherwise).
#[derive(Debug, Default)]
pub struct FakeDesktop {
    pub opened: Mutex<Vec<String>>,
}

impl FakeDesktop {
    fn record(&self, entry: String) -> BoxFuture<'_, Result<(), Error>> {
        self.opened.lock().expect("opened").push(entry);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl DesktopFiles for FakeDesktop {
    fn resolve_default_app<'a>(
        &'a self,
        _path: Option<&'a str>,
        _ext: Option<&'a str>,
    ) -> BoxFuture<'a, Option<AppInfo>> {
        Box::pin(std::future::ready(None))
    }

    fn icon_path_for_bundle_id<'a>(&'a self, _bundle_id: &'a str) -> BoxFuture<'a, Option<std::path::PathBuf>> {
        Box::pin(std::future::ready(None))
    }

    fn open_path<'a>(&'a self, target: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.record(format!("default: {target}"))
    }

    fn reveal_path<'a>(&'a self, path: &'a std::path::Path) -> BoxFuture<'a, Result<(), Error>> {
        self.record(format!("reveal: {}", path.display()))
    }

    fn open_in<'a>(
        &'a self,
        target: OpenIn<'a>,
        path: &'a std::path::Path,
        _line: Option<u32>,
        _column: Option<u32>,
    ) -> BoxFuture<'a, Result<(), Error>> {
        let app = match target {
            OpenIn::FileManager => "file manager",
            OpenIn::Editor(id) => id,
        };
        self.record(format!("{app}: {}", path.display()))
    }

    fn installed_editors(&self) -> Vec<Editor> {
        Vec::new()
    }
}

/// A system prompt that names the session it is for, and remembers the facts it was asked with.
#[derive(Debug, Default)]
pub struct FakePrompts(pub Mutex<Vec<SpawnFacts>>);

impl PromptAssembler for FakePrompts {
    fn system_prompt(&self, facts: &SpawnFacts) -> Option<String> {
        self.0.lock().expect("facts").push(facts.clone());
        Some(format!("PROMPT FOR {}", facts.worker_id))
    }
}

/// A model that answers one-shot requests from a script and keeps what it
/// was asked. A request with no scripted answer left fails.
#[derive(Debug, Default)]
pub struct ScriptedOneShot {
    answers: Mutex<VecDeque<Result<OneShotAnswer, OneShotError>>>,
    pub asked: Mutex<Vec<OneShotRequest>>,
    count: tokio::sync::watch::Sender<usize>,
    gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
}

impl ScriptedOneShot {
    /// The next request answers with this text.
    pub fn text(&self, text: &str) -> &Self {
        self.push(Ok(OneShotAnswer { text: text.to_owned(), structured: None }))
    }

    /// The next request answers with this data.
    pub fn data(&self, data: serde_json::Value) -> &Self {
        self.push(Ok(OneShotAnswer { text: String::new(), structured: Some(data) }))
    }

    /// The next request fails.
    pub fn fail(&self, error: OneShotError) -> &Self {
        self.push(Err(error))
    }

    fn push(&self, answer: Result<OneShotAnswer, OneShotError>) -> &Self {
        self.answers.lock().expect("answers").push_back(answer);
        self
    }

    /// Every request from now on waits until the returned gate is notified
    /// (once per request).
    pub fn hold(&self) -> Arc<tokio::sync::Notify> {
        let gate = Arc::new(tokio::sync::Notify::new());
        *self.gate.lock().expect("gate") = Some(gate.clone());
        gate
    }

    pub fn asked(&self) -> Vec<OneShotRequest> {
        self.asked.lock().expect("asked").clone()
    }

    /// Resolves once `n` requests were made.
    pub async fn until_asked(&self, n: usize) {
        let _ = self.count.subscribe().wait_for(|count| *count >= n).await;
    }
}

impl OneShot for ScriptedOneShot {
    fn complete(&self, request: OneShotRequest) -> BoxFuture<'_, Result<OneShotAnswer, OneShotError>> {
        self.asked.lock().expect("asked").push(request);
        self.count.send_modify(|n| *n += 1);
        let gate = self.gate.lock().expect("gate").clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let next = self.answers.lock().expect("answers").pop_front();
            next.unwrap_or_else(|| Err(OneShotError::Failed("no scripted answer".into())))
        })
    }
}
