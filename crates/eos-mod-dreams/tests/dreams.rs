//! Dreaming over the real store, with a scripted model and in-memory memories.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{UserMemory, UserMemoryScope, UserMemorySource, UserProfile};
use eos_core::accounts::PlanAccess;
use eos_core::agent::OneShotError;
use eos_core::os::TimeZone;
use eos_core::profile::{
    UserMemoryReader, UserMemorySuggestResult, UserMemorySuggestion, UserMemorySuggestionSink, UserProfileReader,
};
use eos_core::{BoxFuture, Error};
use eos_domain::accounts::PlanLoginRecord;
use eos_domain::user_profile::empty_user_profile;
use eos_mod_dreams::{DreamParts, DreamsModule};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_runtime::access::Caller;
use eos_runtime::bus::EventReceiver;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::prompts::LibraryPromptSource;
use eos_testkit::{FakeClock, FakeConfig, FakeProfileRenderer, FakeSleeper, ScriptedOneShot, SeqIds, TempStore};
use serde_json::{Value, json};

/// 2026-03-10 12:00 UTC: an afternoon.
const NOON: i64 = 1_773_144_000_000;
const HOUR: i64 = 3_600_000;

struct Utc;

impl TimeZone for Utc {
    fn name(&self) -> String {
        "UTC".into()
    }
    fn offset_minutes_at(&self, _epoch_ms: i64) -> i32 {
        0
    }
}

struct Profile(Mutex<UserProfile>);

impl UserProfileReader for Profile {
    fn get(&self) -> Arc<UserProfile> {
        Arc::new(self.0.lock().expect("profile").clone())
    }
}

/// The memory service as a dream sees it: what is kept, and where proposals go.
#[derive(Default)]
struct Memories {
    kept: Vec<Arc<UserMemory>>,
    filed: Mutex<Vec<(UserMemorySuggestion, UserMemorySource)>>,
    /// The review queue is full.
    full: bool,
}

impl UserMemoryReader for Memories {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        self.kept.clone()
    }
    fn search(&self, _query: &str, _project: Option<&str>, _limit: usize) -> Vec<Arc<UserMemory>> {
        Vec::new()
    }
}

impl UserMemorySuggestionSink for Memories {
    fn suggest(&self, input: UserMemorySuggestion, source: UserMemorySource) -> Result<UserMemorySuggestResult, Error> {
        if self.full {
            return Err(Error::LimitExceeded("the review queue is full".into()));
        }
        self.filed.lock().expect("filed").push((input.clone(), source.clone()));
        let memory: UserMemory = serde_json::from_value(json!({
            "id": "um-000000000001", "text": input.text, "category": input.category, "scope": input.scope,
            "tier": "always", "status": "suggested", "source": source, "rev": 1, "createdAt": 1, "updatedAt": 1,
        }))
        .expect("a memory");
        Ok(UserMemorySuggestResult { memory: Arc::new(memory), duplicate: false, declined: false })
    }
}

struct Plan {
    signed_in: bool,
    used: Option<f64>,
}

impl PlanAccess for Plan {
    fn logins(&self, _provider: &str) -> Vec<PlanLoginRecord> {
        let login = PlanLoginRecord {
            id: "l1".into(),
            provider: "anthropic".into(),
            label: "me".into(),
            email: None,
            store_dir: "/accounts/claude".into(),
            created_at: String::new(),
        };
        if self.signed_in { vec![login] } else { Vec::new() }
    }
    fn access_token<'a>(&'a self, _provider: &'a str, _login_id: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }
    fn token_refused<'a>(&'a self, _provider: &'a str, _login_id: &'a str, _rejected: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(std::future::ready(false))
    }
    fn login_of_worker(&self, _provider: &str, _worker_id: &str) -> Option<String> {
        None
    }
    fn utilization<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<f64>> {
        Box::pin(std::future::ready(self.used))
    }
}

struct Bench {
    runtime: Runtime,
    module: Arc<DreamsModule>,
    temp: TempStore,
    model: Arc<ScriptedOneShot>,
    memories: Arc<Memories>,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
    changes: tokio::sync::Mutex<EventReceiver>,
    /// The row of `w-CHAT`'s first message from the user.
    said: i64,
}

struct Setup {
    dreaming: Value,
    plan: Plan,
    memories: Memories,
}

impl Default for Setup {
    fn default() -> Self {
        Self { dreaming: json!({}), plan: Plan { signed_in: true, used: Some(0.2) }, memories: Memories::default() }
    }
}

impl Bench {
    /// On the wire fixtures' rows, with every top-level chat but `w-CHAT` kept out of dreams.
    async fn new(setup: Setup) -> Self {
        let clock = Arc::new(FakeClock::at(NOON));
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
        let temp = TempStore::seeded_on_bus("/sandbox", &kernel.bus);
        for other in ["w-LONG", "o-ORCH", "w-ARCH", "w-BARE"] {
            temp.exec(&format!("INSERT INTO dream_exclusions (worker_id) VALUES ('{other}')"));
        }
        let said = temp
            .store
            .read_blocking(|tx| tx.events().list_by_type("w-CHAT", eos_contracts::WorkerEventType::UserMessage, None))
            .expect("reads")[0]
            .id;
        let mut profile = empty_user_profile();
        let mut dreaming = serde_json::to_value(&profile.dreaming).expect("json");
        for (key, value) in setup.dreaming.as_object().expect("an object") {
            dreaming[key] = value.clone();
        }
        profile.dreaming = serde_json::from_value(dreaming).expect("dreaming settings");
        let (model, memories) = (Arc::new(ScriptedOneShot::default()), Arc::new(setup.memories));
        let sleeper = Arc::new(FakeSleeper::default());
        let library = Arc::new(LibraryPromptSource::embedded());
        let parts = DreamParts {
            store: temp.port(),
            one_shot: model.clone(),
            prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
            memories: memories.clone(),
            suggestions: memories.clone(),
            profile: Arc::new(Profile(Mutex::new(profile))),
            profile_text: Arc::new(FakeProfileRenderer::with_text("The user is a developer.")),
            config: Arc::new(FakeConfig::default()),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            zone: Arc::new(Utc),
        };
        let changes = tokio::sync::Mutex::new(kernel.bus.subscribe(&eos_mod_dreams::DREAM_CHANGE, 64));
        let module = Arc::new(DreamsModule::new(
            parts,
            Arc::new(setup.plan),
            kernel.bus.clone(),
            kernel.jobs.clone(),
            sleeper.clone(),
        ));
        let runtime = Runtime::build(kernel, vec![module.clone()], Arc::new(AllPluginsOn)).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("starts");
        Self { runtime, module, temp, model, memories, clock, sleeper, changes, said }
    }

    async fn call(&self, method: Method, caller: Caller, target: &str, body: Option<Value>) -> (u16, Value) {
        let mut req = Request::new(method, target, caller);
        if let Some(body) = body {
            req = req.body(serde_json::to_vec(&body).expect("json"));
        }
        let response = self.runtime.router.handle(req).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// The next `dream:change` that says a dream is over.
    async fn ended(&self) -> Value {
        let mut changes = self.changes.lock().await;
        loop {
            let event = tokio::time::timeout(Duration::from_secs(10), changes.recv())
                .await
                .expect("a change")
                .expect("an event");
            let change: Value = event.payload_as().expect("json");
            if change["status"] != "running" {
                return change;
            }
        }
    }

    async fn runs(&self) -> Vec<Value> {
        let (_, body) = self.call(Method::Get, Caller::UNTRUSTED, "/api/dreams", None).await;
        body["runs"].as_array().cloned().unwrap_or_default()
    }

    /// What the model says about `w-CHAT`: one standing rule the user's own
    /// words ground, and one step of the task at hand.
    fn script_recall(&self) {
        self.model.data(json!({"signals": [
            {"ask": "Check empty input before saying a parser change is done", "object": "agent-behaviour",
             "stance": "general-rule", "marker": "empty input", "evidence": [self.said]},
            {"ask": "Return an empty list here", "object": "agent-behaviour", "stance": "task-instruction",
             "evidence": [self.said]},
        ]}));
    }

    fn script_match(&self) {
        self.model
            .data(json!({"groups": [{"signals": [0], "claim": "Check empty input before reporting a parser change"}]}));
    }

    fn script_consolidate(&self, text: &str) {
        self.model.data(json!({
            "narrative": "You want empty input checked first.",
            "proposals": [{"candidate": "dc-000000000001-1", "kind": "new", "text": text, "category": "work-style",
                           "domain": "code", "targets": [], "why": "It was missed once already"}],
            "setAside": [],
        }));
    }

    fn script_critic(&self, keep: bool) {
        self.model.data(
            json!({"verdicts": [{"proposal": 0, "keep": keep, "fails": if keep { json!([]) } else { json!([3]) },
            "quotes": [{"eventId": self.said, "says": "yes"}], "reason": if keep { "" } else { "Too obvious" }}]}),
        );
    }

    fn ledger(&self) -> Vec<String> {
        let ledger = self.temp.store.read_blocking(|tx| tx.dreams().candidates()).expect("reads");
        ledger.into_iter().map(|c| c.id).collect()
    }

    fn watermark(&self) -> i64 {
        self.temp.store.read_blocking(|tx| tx.dreams().watermark("w-CHAT")).expect("reads")
    }
}

const RULE: &str = "When a parser change is done, check empty input before reporting it.";

#[tokio::test(flavor = "multi_thread")]
async fn a_stated_rule_goes_recall_match_consolidate_critic_and_is_filed() {
    let bench = Bench::new(Setup::default()).await;
    bench.script_recall();
    bench.script_match();
    bench.script_consolidate(RULE);
    bench.script_critic(true);
    // "Dream now" runs although dreaming is switched off.
    let started = bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(started, (202, json!({"started": true})));
    let end = bench.ended().await;
    assert_eq!(end["status"], "done");

    let asked = bench.model.asked();
    assert_eq!(asked.len(), 4, "recall, match, consolidate, critic");
    assert!(asked.iter().all(|a| a.model.as_deref() == Some("opus") && a.schema.is_some() && a.system.is_some()));
    assert!(asked[0].prompt.contains(&format!("[e{}] USER: Fix the parser", bench.said)), "{}", asked[0].prompt);
    assert!(
        asked[1].prompt.contains(
            "s0 · agent-behaviour · general-rule · chat Fix the parser (/sandbox/alpha) · marker “empty input”"
        )
    );
    assert!(
        asked[2]
            .prompt
            .contains("dc-000000000001-1 · seen in 1 chat on 1 day across 1 project · stated as a standing rule")
    );
    assert!(asked[3].prompt.contains("p0 · new · project /sandbox/alpha"), "{}", asked[3].prompt);
    assert!(!serde_json::to_string(&asked[0].schema).expect("json").contains("$ref"), "nothing left to look up");

    let filed = bench.memories.filed.lock().expect("filed").clone();
    assert_eq!(filed.len(), 1);
    assert_eq!(filed[0].0.text, RULE);
    assert!(matches!(&filed[0].0.scope, UserMemoryScope::Project(p) if p.path == "/sandbox/alpha"));
    let UserMemorySource::Dream(source) = &filed[0].1 else { panic!("a dream's: {:?}", filed[0].1) };
    assert_eq!((source.dream_id.as_str(), source.evidence[0].event_id), ("dr-000000000001", Some(bench.said)));
    let support = filed[0].0.proposal.as_ref().and_then(|p| p.support.clone()).expect("its support");
    assert_eq!((support.chats, support.days), (1, 1));

    let run = bench.runs().await.remove(0);
    assert_eq!(
        (&run["status"], &run["proposed"], &run["chatsRead"], &run["observations"]),
        (&json!("done"), &json!(1), &json!(1), &json!(2))
    );
    assert_eq!(
        (&run["dropped"]["taskBound"], &run["narrative"]),
        (&json!(1), &json!("You want empty input checked first."))
    );
    assert_eq!((&run["trigger"], &run["reason"], &run["candidates"]), (&json!("manual"), &Value::Null, &json!(0)));
    assert!(bench.ledger().is_empty(), "a settled candidate leaves the ledger");
    assert!(bench.watermark() > 0, "the chat is read");
    assert!(bench.runtime.kernel.jobs.list().iter().any(|j| j.kind == "dream"), "it showed in the Jobs tab");

    // Nothing new since: skipped, with no request to the model.
    bench.clock.advance(60_000);
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(bench.ended().await["status"], "skipped");
    assert_eq!(bench.runs().await[0]["reason"], "Nothing new since the last dream");
    assert_eq!(bench.model.asked().len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_inferred_wish_waits_in_the_ledger_and_a_refuted_or_badly_written_proposal_is_not_filed() {
    // No marker: nothing the user stated as a rule, seen once.
    let bench = Bench::new(Setup::default()).await;
    bench.model.data(json!({"signals": [{"ask": "Prefers short answers", "object": "agent-behaviour",
        "stance": "process-correction", "marker": "never said", "evidence": [bench.said]}]}));
    bench.model.data(json!({"groups": [{"signals": [0], "claim": "Keep answers short"}]}));
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(bench.ended().await["status"], "done");
    let run = bench.runs().await.remove(0);
    assert_eq!(run["reason"], "Nothing ready yet — 1 idea is still gathering support");
    assert_eq!((bench.ledger(), bench.model.asked().len()), (vec!["dc-000000000001-1".to_owned()], 2));

    // The critic refutes: nothing filed, the reason is on record, the candidate is settled.
    let bench = Bench::new(Setup::default()).await;
    bench.script_recall();
    bench.script_match();
    bench.script_consolidate(RULE);
    bench.script_critic(false);
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    bench.ended().await;
    let run = bench.runs().await.remove(0);
    assert_eq!((&run["proposed"], &run["dropped"]["critic"]), (&json!(0), &json!(1)));
    assert_eq!(run["reason"], "Nothing passed review this time");
    assert_eq!(run["rejected"], json!([{"text": RULE, "reason": "Too obvious (an agent would do it anyway)"}]));
    assert!(bench.ledger().is_empty() && bench.memories.filed.lock().expect("filed").is_empty());

    // A proposal that hedges never reaches the critic.
    let bench = Bench::new(Setup::default()).await;
    bench.script_recall();
    bench.script_match();
    bench.script_consolidate("The user usually wants empty input checked.");
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    bench.ended().await;
    let run = bench.runs().await.remove(0);
    assert_eq!((bench.model.asked().len(), &run["dropped"]["style"]), (3, &json!(1)));
    assert!(run["rejected"][0]["reason"].as_str().is_some_and(|r| r.starts_with("Writing: hedges")), "{run}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_step_keeps_the_ledger_and_a_full_review_queue_keeps_the_candidate() {
    // The match answer does not fit its schema: nothing is filed in the ledger, the chat stays unread.
    let bench = Bench::new(Setup::default()).await;
    bench.script_recall();
    bench.model.data(json!({"groups": "nope"}));
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(bench.ended().await["status"], "failed");
    assert_eq!(bench.runs().await[0]["reason"], "Couldn't file tonight's signals — the answer didn't fit its schema");
    assert_eq!((bench.ledger().len(), bench.watermark()), (0, 0));

    // The consolidation fails: the ready candidate waits for the next dream.
    let bench = Bench::new(Setup::default()).await;
    bench.script_recall();
    bench.script_match();
    bench.model.fail(OneShotError::Failed("overloaded".into()));
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    bench.ended().await;
    assert_eq!(bench.runs().await[0]["reason"], "Couldn't weigh what it noticed: overloaded");
    assert_eq!(bench.ledger().len(), 1);

    // No room in the review queue: counted as capped, and the candidate stays.
    let bench =
        Bench::new(Setup { memories: Memories { full: true, ..Memories::default() }, ..Setup::default() }).await;
    bench.script_recall();
    bench.script_match();
    bench.script_consolidate(RULE);
    bench.script_critic(true);
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    bench.ended().await;
    let run = bench.runs().await.remove(0);
    assert_eq!((&run["dropped"]["capped"], &run["proposed"], bench.ledger().len()), (&json!(1), &json!(0), 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_sign_in_or_over_the_usage_line_the_night_is_skipped_with_no_request() {
    let out = Bench::new(Setup { plan: Plan { signed_in: false, used: None }, ..Setup::default() }).await;
    let (status, state) = out.call(Method::Get, Caller::UNTRUSTED, "/api/dreams/status", None).await;
    let off = json!({"running": false, "runId": null, "progress": null, "lastRun": null, "nextAt": null, "blocked": "disabled"});
    assert_eq!((status, state), (200, off));
    assert_eq!(out.call(Method::Post, Caller::UNTRUSTED, "/api/dreams", None).await.0, 403);
    assert_eq!(out.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await, (202, json!({"started": true})));
    // On record by the time "Dream now" has answered.
    let run = out.runs().await.remove(0);
    assert_eq!((&run["status"], &run["trigger"], &run["model"]), (&json!("skipped"), &json!("manual"), &json!("opus")));
    assert_eq!(run["reason"], "Needs a Claude sign-in — dreams run on your plan, never an API key");
    let id = run["id"].as_str().expect("an id");
    assert_eq!(
        out.call(Method::Get, Caller::UNTRUSTED, &format!("/api/dreams/{id}"), None).await,
        (200, json!({"run": run}))
    );
    let unknown = out.call(Method::Get, Caller::UNTRUSTED, "/api/dreams/dr-nope", None).await;
    assert_eq!(unknown, (404, json!({"error": "no such dream"})));
    assert!(out.runtime.kernel.jobs.list().is_empty(), "a skipped dream leaves no job");

    let busy = Bench::new(Setup { plan: Plan { signed_in: true, used: Some(0.91) }, ..Setup::default() }).await;
    busy.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(busy.ended().await["status"], "skipped");
    assert_eq!(busy.runs().await[0]["reason"], "Held off — plan usage at 91%, above your 70% line");
    assert!(busy.model.asked().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn switched_on_in_the_afternoon_it_waits_for_tonights_slot_then_dreams_once() {
    let bench = Bench::new(Setup { dreaming: json!({"enabled": true}), ..Setup::default() }).await;
    let dreams = bench.module.dreams().clone();
    dreams.tick().await;
    assert!(bench.runs().await.is_empty(), "the slot of last night passed before it was switched on");
    let (_, state) = bench.call(Method::Get, Caller::UNTRUSTED, "/api/dreams/status", None).await;
    assert_eq!((&state["blocked"], state["nextAt"].as_i64()), (&Value::Null, Some(NOON + 15 * HOUR)), "03:00 tomorrow");

    // 03:10 the next night: due. The model is held, so the dream is seen running.
    bench.clock.set(NOON + 15 * HOUR + 600_000);
    let gate = bench.model.hold();
    bench.script_recall();
    bench.model.data(json!({"groups": []}));
    let running = {
        let dreams = dreams.clone();
        tokio::spawn(async move { dreams.tick().await })
    };
    bench.model.until_asked(1).await;
    let (_, state) = bench.call(Method::Get, Caller::UNTRUSTED, "/api/dreams/status", None).await;
    assert_eq!((&state["running"], &state["progress"]["total"]), (&json!(true), &json!(1)));
    let second = bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(second, (409, json!({"error": "A dream is already running"})));
    let job = bench.runtime.kernel.jobs.list().remove(0);
    assert_eq!((job.kind.as_str(), job.can_stop), ("dream", true));

    // The user comes back: a top-level chat starts working. A scheduled dream stops after its chat.
    let back = json!({"workerId": "w-CHAT", "from": "IDLE", "state": "WORKING"});
    bench.runtime.kernel.bus.publish_raw("worker:change", None, back.to_string().into());
    bench.runtime.kernel.bus.flush().await;
    let stop = bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams/stop", None).await;
    assert_eq!(stop, (200, json!({"stopping": true})));
    gate.notify_one();
    gate.notify_one();
    running.await.expect("the tick");
    let run = bench.runs().await.remove(0);
    assert_eq!((&run["trigger"], &run["chatsRead"]), (&json!("nightly"), &json!(1)));

    // Once per slot.
    dreams.tick().await;
    assert_eq!(bench.runs().await.len(), 1);
    assert!(!bench.sleeper.pending().is_empty(), "the schedule is looked at every minute");
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_a_chat_off_is_the_users() {
    let bench = Bench::new(Setup::default()).await;
    let body = json!({"workerId": "w-CHAT", "excluded": true});
    let refused = bench.call(Method::Post, Caller::UNTRUSTED, "/api/dreams/exclusions", Some(body.clone())).await;
    assert_eq!(refused.0, 403);
    let (status, answer) = bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams/exclusions", Some(body)).await;
    assert_eq!(status, 200);
    assert!(answer["excluded"].as_array().is_some_and(|list| list.contains(&json!("w-CHAT"))));
    let invalid =
        bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams/exclusions", Some(json!({"workerId": ""}))).await;
    assert_eq!(invalid.0, 400);
    // Every chat is kept out now: nothing to read.
    bench.call(Method::Post, Caller::DASHBOARD, "/api/dreams", None).await;
    assert_eq!(bench.ended().await["status"], "skipped");
    assert!(bench.model.asked().is_empty());
}
