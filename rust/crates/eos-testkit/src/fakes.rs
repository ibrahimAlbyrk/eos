//! Fakes of the ports that reach outside the process.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use eos_contracts::UserSettings;
use eos_contracts::{AllowVariant, CatalogModel, DenyVariant, ExternalDecision, UnknownRecord};
use eos_core::accounts::{PlanFailure, PlanLimits, PlanVerdict, SessionCredential, SessionCredentials};
use eos_core::agent::{
    HostTool, LaunchSpec, ModelCatalog, PromptAssembler, ScratchFolders, SpawnFacts, ToolCaller, ToolDefinition,
    ToolReply, ToolSets, UserQuestions,
};
use eos_core::git::{WorktreeCreate, WorktreeCreated, WorktreeEntry, WorktreeManager, WorktreeRef, WorktreeRemoved};
use eos_core::policy::{PolicyDecider, ToolCall};
use eos_core::store::{RecentFolders, UserSettingsStore};
use eos_core::{BoxFuture, Error};

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
}

impl UserQuestions for FakeUser {
    fn ask<'a>(
        &'a self,
        _worker_id: &'a str,
        _call_id: Option<&'a str>,
        questions: Vec<UnknownRecord>,
    ) -> BoxFuture<'a, Option<UnknownRecord>> {
        self.asked.lock().expect("asked").push(questions);
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

/// A system prompt that names the session it is for, and remembers the facts it was asked with.
#[derive(Debug, Default)]
pub struct FakePrompts(pub Mutex<Vec<SpawnFacts>>);

impl PromptAssembler for FakePrompts {
    fn system_prompt(&self, facts: &SpawnFacts) -> Option<String> {
        self.0.lock().expect("facts").push(facts.clone());
        Some(format!("PROMPT FOR {}", facts.worker_id))
    }
}
