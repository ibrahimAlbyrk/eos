//! A routine on a pull request source in the composed app, with fakes only: the source,
//! the channels and the clock are the test's, the agents the scripted runtime's. Made
//! through the routes, its runs driven through the run tools as the lead and the checker
//! would call them.
#![allow(dead_code, unreachable_pub)]

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, CapabilityOptions, Options};
use eos_contracts::{ActionClass, Fact, Facts};
use eos_core::agent::{ToolCaller, ToolReply};
use eos_core::delivery::{ChannelTraits, Idempotency, Undo};
use eos_core::signals::{PollPage, SignalDraft};
use eos_core::store::StoredRun;
use eos_runtime::http::Method;
use eos_testkit::agent::Turn;
use eos_testkit::{FakeChannels, FakeClock, FakeSignalSources, FakeSource, ScriptedRuntime};
use serde_json::{Value, json};

use crate::rig;

pub const REPO: &str = "acme/game";

/// The source, the channels and the clock a test drives.
pub struct Fakes {
    pub source: Arc<FakeSource>,
    pub channels: FakeChannels,
    pub clock: Arc<FakeClock>,
}

impl Fakes {
    pub fn new() -> Self {
        let traits = |class| ChannelTraits {
            class,
            idempotency: Idempotency::Marker,
            undo: Undo::Partial,
            undo_window_ms: 0,
            max_bytes: 65_536,
        };
        Self {
            // As GitHub's pull requests: a closed one ends its subject.
            source: Arc::new(FakeSource::default().closing(&["closed"])),
            channels: FakeChannels::new()
                .with("github", traits(ActionClass::Speak))
                .with("mail", traits(ActionClass::Speak)),
            clock: Arc::new(FakeClock::new()),
        }
    }

    /// The app on `home`, reaching the network (as the installed app) or not (a dev run).
    pub fn app(&self, home: &Path, agents: &ScriptedRuntime, network: bool) -> App {
        let capabilities = CapabilityOptions {
            sources: Some(Arc::new(FakeSignalSources::new().with("github.pulls", self.source.clone()))),
            channels: Some(Arc::new(self.channels.clone())),
            ..CapabilityOptions::default()
        };
        let options = rig::options(home, agents, capabilities);
        App::build(Options { clock: self.clock.clone(), reaches_network: network, ..options }).expect("builds")
    }

    /// Time enough for the next poll, and a wake so the scheduler looks at once.
    pub fn poll_again(&self, app: &App) {
        self.clock.advance(2 * 60_000);
        app.woke(Duration::from_secs(0));
    }
}

/// Agents whose every turn keeps working until stopped: a run's lead and checker never
/// end a turn without the result the test hands in for them.
pub fn working_agents() -> ScriptedRuntime {
    let agents = ScriptedRuntime::new();
    agents.otherwise(|_, _| Turn::reply("Working on it.").held().0);
    agents
}

/// Pull request `n` of [`REPO`] at `sha`, titled `title`.
pub fn pull(n: u64, sha: &str, kind: &str, title: &str) -> SignalDraft {
    let mut facts = Facts::new();
    facts.insert("repo".into(), Fact::Text(REPO.into()));
    let key = format!("github:pr:{REPO}#{n}");
    // As GitHub's source keys them: an event beyond a change is part of the key.
    let event = if matches!(kind, "opened" | "updated") { String::new() } else { format!(":{kind}") };
    SignalDraft {
        key: format!("{key}@{sha}{event}"),
        subject: key.clone(),
        version: Some(sha.into()),
        kind: kind.into(),
        occurred_at: 1_000,
        facts,
        item: json!({"kind": "github.pull_request", "key": key, "title": title, "version": sha, "untrusted": true}),
    }
}

pub fn page(items: Vec<SignalDraft>, more: bool) -> PollPage {
    PollPage { items, cursor: json!({"page": 1}), more, baseline: false, poll_after_ms: None, retry_at: None }
}

/// A review of [`REPO`]'s pull requests, by one agent with a checker, held as a draft.
pub fn review_blueprint(brief: &str) -> Value {
    json!({
        "format": 1, "name": "PR Review", "summary": "Reviews a pull request.", "icon": "eye", "kind": "standing",
        "takes": {"kind": "github.pull_request", "label": "pull request", "placeholder": "#470",
                  "empty": "required", "many": true},
        "options": [],
        "when": {"on": [{"source": "github.pulls", "scope": {"repo": REPO}, "events": ["opened", "updated"]}]},
        "which": {},
        "who": {"depth": "solo", "agents": [{"key": "reviewer", "name": "Reviewer", "lead": true, "brief": brief,
                "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"}],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": "review", "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [{"id": "pr", "kind": "item_place", "channel": "github", "bound": {"fact": "repo", "in": [REPO]}}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 2, "perRunMinutes": 30, "perDayUsd": 5, "parallel": 1},
    })
}

/// A review result as the lead hands it in.
pub fn review_doc(text: &str) -> Value {
    json!({"kind": "github.review", "channel": "github", "action": "post_review",
           "parts": [{"key": "summary", "role": "summary", "text": text}]})
}

/// Makes the routine by hand and starts it; its id.
pub async fn make(app: &App, blueprint: Value) -> String {
    let (status, saved) = rig::call(app, Method::Post, "/api/routines", Some(json!({"blueprint": blueprint}))).await;
    assert_eq!(status, 201, "{saved}");
    let id = saved["row"]["id"].as_str().expect("an id").to_owned();
    let (status, row) =
        rig::call(app, Method::Post, &format!("/api/routines/{id}/start"), Some(json!({"withoutTrial": true}))).await;
    assert_eq!(status, 200, "{row}");
    id
}

/// Waits, a bounded while, until `done` answers true.
pub async fn eventually<F, Fut>(what: &str, done: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..400 {
        if done().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never happened: {what}");
}

/// The routine's runs, newest first.
pub async fn runs(app: &App, routine: &str) -> Vec<StoredRun> {
    let id = routine.to_owned();
    app.store().read(move |tx| tx.runs().by_routine(&id, 100)).await.expect("reads")
}

pub async fn run(app: &App, id: &str) -> StoredRun {
    let id = id.to_owned();
    app.store().read(move |tx| tx.runs().find(&id)).await.expect("reads").expect("the run")
}

/// Calls `tool` as the engine calls it for `worker`'s model.
pub async fn call_tool(app: &App, agents: &ScriptedRuntime, worker: &str, tool: &str, input: Value) -> ToolReply {
    let spec = agents.started().into_iter().find(|spec| spec.worker_id == worker).expect("the worker's session");
    let tools = app.tools().for_session(&spec);
    let found = tools.iter().find(|t| t.definition().name == tool).unwrap_or_else(|| panic!("{tool}"));
    found.call(ToolCaller { worker_id: worker, call_id: "toolu_routine", subagent_id: None }, input).await
}

/// The lead of `run` once it works.
pub async fn lead(app: &App, agents: &ScriptedRuntime, run_id: &str) -> String {
    eventually("the lead's session starts", || async {
        let lead = run(app, run_id).await.lead_id;
        lead.is_some_and(|lead| agents.started().iter().any(|spec| spec.worker_id == lead))
    })
    .await;
    run(app, run_id).await.lead_id.expect("a lead")
}

/// The lead of `run` hands in `doc`; a checker, when the routine has one, passes it.
pub async fn hand_in(app: &App, agents: &ScriptedRuntime, run_id: &str, headline: &str, doc: Value, checked: bool) {
    let lead = lead(app, agents, run_id).await;
    let checkers =
        || agents.started().into_iter().filter(|s| s.worker_definition.as_deref() == Some("eos-run-checker"));
    let before = checkers().count();
    let result = json!({"kind": doc["kind"], "headline": headline, "body": doc});
    let reply = call_tool(app, agents, &lead, "submit_result", result).await;
    assert!(!reply.is_error, "{}", reply.text);
    if checked {
        eventually("a checker starts", || async { checkers().count() > before }).await;
        let checker = checkers().next_back().expect("a checker").worker_id;
        let verdict = json!({"pass": true, "checks": [], "mustFix": []});
        let reply = call_tool(app, agents, &checker, "submit_verdict", verdict).await;
        assert!(!reply.is_error, "{}", reply.text);
    }
}

/// The items waiting in Needs you.
pub async fn inbox(app: &App) -> Vec<Value> {
    let (status, list) = rig::call(app, Method::Get, "/api/inbox", None).await;
    assert_eq!(status, 200, "{list}");
    list["items"].as_array().cloned().unwrap_or_default()
}
