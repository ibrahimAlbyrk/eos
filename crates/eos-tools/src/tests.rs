//! The registry held to what the TypeScript registry gives agents
//! (`fixtures/tools`, frozen from the TypeScript, see `fixtures/README.md`).

use std::sync::Arc;

use eos_capabilities::{CapabilityPorts, CapabilityService};
use eos_contracts::SessionFactsRole;
use eos_core::agent::{HostTool, LaunchSpec, ToolCaller, ToolReply, ToolSets};
use eos_core::capability::{AllInstalled, BuiltinCapability};
use eos_core::routine::{RoutineTools, SubmittedResult};
use eos_prompts::PromptRegistry;
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_testkit::{
    FakeActionRunner, FakeCapabilityFiles, FakeCapabilitySecrets, FakeClock, FakeFeatures, FakeModelCatalog,
    FakeSleeper, FakeTimeZone, FakeTrash, SeqIds, TempStore,
};
use eos_workers::WorkerDefinitions;
use serde_json::Value;

use crate::{Services, Tools, Visual};

pub(crate) fn fixture(file: &str) -> Value {
    let path = format!("{}/../../fixtures/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The registry over scripted features, every optional one handed over.
pub(crate) struct Bench {
    pub(crate) tools: Tools,
    pub(crate) features: Arc<FakeFeatures>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) store: TempStore,
    /// The capability service the capability tools call, on the same database.
    pub(crate) capabilities: Arc<CapabilityService>,
    pub(crate) runner: Arc<FakeActionRunner>,
    /// What the run tools asked of the routines feature.
    pub(crate) runs: RunCalls,
}

/// The routines feature as the run tools reach it: each call recorded, a
/// worker named `w-none` refused as one of no run.
#[derive(Clone, Default)]
pub(crate) struct RunCalls(pub(crate) Arc<std::sync::Mutex<Vec<String>>>);

impl RunCalls {
    fn record(&self, worker_id: &str, call: String) -> eos_core::BoxFuture<'static, Result<(), eos_core::Error>> {
        let answer = if worker_id == "w-none" {
            Err(eos_core::Error::Conflict("this session works for no run".into()))
        } else {
            self.0.lock().expect("calls").push(call);
            Ok(())
        };
        Box::pin(std::future::ready(answer))
    }
}

impl eos_core::forge::Forge for RunCalls {
    fn request(
        &self,
        request: eos_core::forge::ForgeRequest,
    ) -> eos_core::BoxFuture<'_, Result<eos_core::forge::ForgeAnswer, eos_core::Error>> {
        use eos_core::forge::{ForgeAnswer, ForgeCaller};
        let ForgeCaller::Agent { worker_id } = &request.caller else { panic!("an agent asks") };
        let written = self.record(worker_id, format!("forge {worker_id} {} {:?}", request.need, request.routine_id));
        let answer = match request.need.as_str() {
            "github" => ForgeAnswer::Setup { capability_id: "github".into(), step: "Sign in to GitHub.".into() },
            _ => ForgeAnswer::Started { run_id: "rn-forge".into() },
        };
        Box::pin(async move { written.await.map(|()| answer) })
    }

    fn report<'a>(
        &'a self,
        worker_id: &'a str,
        stage: eos_core::forge::ForgeStage,
        report: Value,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("report {worker_id} {} {report}", stage.as_str()))
    }
}

impl eos_core::surface::SurfaceTools for RunCalls {
    fn return_view<'a>(
        &'a self,
        worker_id: &'a str,
        view: eos_core::surface::ReturnedView,
    ) -> eos_core::BoxFuture<'a, Result<String, eos_core::Error>> {
        if view.place == "question" {
            let problems = "view.ui: is required\nbindings.go: binds no send action of the view".to_owned();
            return Box::pin(std::future::ready(Err(eos_core::Error::Validation(problems))));
        }
        let beside: String = [("facts", &view.facts), ("aside", &view.aside)]
            .iter()
            .filter_map(|(name, value)| value.as_ref().map(|v| format!(" {name} {v}")))
            .collect();
        self.0.lock().expect("calls").push(format!("view {worker_id} {} {}{beside}", view.place, view.view));
        Box::pin(std::future::ready(Ok("issue si-000000000001 · 0 bound actions".to_owned())))
    }

    fn fill_page<'a>(
        &'a self,
        worker_id: &'a str,
        data: Value,
    ) -> eos_core::BoxFuture<'a, Result<String, eos_core::Error>> {
        self.0.lock().expect("calls").push(format!("page {worker_id} {data}"));
        Box::pin(std::future::ready(Ok("issue si-000000000002 accepted".to_owned())))
    }

    fn page_design_read<'a>(&'a self, worker_id: &'a str) -> eos_core::BoxFuture<'a, Result<Value, eos_core::Error>> {
        self.0.lock().expect("calls").push(format!("design read {worker_id}"));
        Box::pin(std::future::ready(Ok(serde_json::json!({"current": null}))))
    }

    fn page_design_propose<'a>(
        &'a self,
        worker_id: &'a str,
        design: Value,
        note: String,
    ) -> eos_core::BoxFuture<'a, Result<String, eos_core::Error>> {
        self.0.lock().expect("calls").push(format!("design propose {worker_id} {design} {note}"));
        Box::pin(std::future::ready(Ok("candidate version 2".to_owned())))
    }

    fn app_propose<'a>(
        &'a self,
        worker_id: &'a str,
        app: Value,
        note: String,
    ) -> eos_core::BoxFuture<'a, Result<String, eos_core::Error>> {
        self.0.lock().expect("calls").push(format!("app propose {worker_id} {app} {note}"));
        Box::pin(std::future::ready(Ok("version 1 waits for its review and its tests".to_owned())))
    }

    fn app_review<'a>(
        &'a self,
        worker_id: &'a str,
        verdict: Value,
    ) -> eos_core::BoxFuture<'a, Result<String, eos_core::Error>> {
        self.0.lock().expect("calls").push(format!("app review {worker_id} {verdict}"));
        Box::pin(std::future::ready(Ok("review recorded".to_owned())))
    }
}

impl RoutineTools for RunCalls {
    fn report_progress<'a>(
        &'a self,
        worker_id: &'a str,
        line: &'a str,
        milestone: Option<&'a str>,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("progress {worker_id} {line} {milestone:?}"))
    }

    fn submit_result<'a>(
        &'a self,
        worker_id: &'a str,
        result: SubmittedResult,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        let SubmittedResult { kind, headline, body, files } = result;
        self.record(worker_id, format!("result {worker_id} {kind} {headline} {body} {files:?}"))
    }

    fn complete_milestone<'a>(
        &'a self,
        worker_id: &'a str,
        done: eos_core::routine::MilestoneDone,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("milestone {worker_id} {} {} {:?}", done.key, done.summary, done.files))
    }

    fn report_failure<'a>(
        &'a self,
        worker_id: &'a str,
        reason: &'a str,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("failure {worker_id} {reason}"))
    }

    fn start_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
        task: &'a str,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("start {worker_id} {agent} {task}"))
    }

    fn message_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
        text: &'a str,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("message {worker_id} {agent} {text}"))
    }

    fn stop_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("stop {worker_id} {agent}"))
    }

    fn list_specialists<'a>(
        &'a self,
        worker_id: &'a str,
    ) -> eos_core::BoxFuture<'a, Result<Vec<eos_core::routine::Specialist>, eos_core::Error>> {
        let listed = self.record(worker_id, format!("list {worker_id}"));
        Box::pin(async move {
            listed.await?;
            Ok(vec![eos_core::routine::Specialist {
                agent: "tester".into(),
                name: "Tester".into(),
                state: "working",
                last_report: None,
            }])
        })
    }
}

/// A routine `pr-review` that waits for the user's click, and `digest`, which
/// agents may start.
impl eos_core::routine::ChatRoutines for RunCalls {
    fn list(&self) -> eos_core::BoxFuture<'_, Result<Vec<eos_core::routine::ChatRoutine>, eos_core::Error>> {
        Box::pin(std::future::ready(Ok(vec![eos_core::routine::ChatRoutine {
            slug: "pr-review".into(),
            name: "PR Review".into(),
            summary: "Reviews a pull request.".into(),
            takes: "Pull request".into(),
            agents_may_start: false,
        }])))
    }

    fn run<'a>(
        &'a self,
        worker_id: &'a str,
        ask: eos_core::routine::ChatRunAsk,
    ) -> eos_core::BoxFuture<'a, Result<eos_core::routine::ChatStart, eos_core::Error>> {
        use eos_core::routine::ChatStart;
        let recorded = self.record(worker_id, format!("run {worker_id} {ask:?}"));
        Box::pin(async move {
            recorded.await?;
            Ok(match ask.routine.as_str() {
                "digest" => ChatStart::Started {
                    run_id: "rn-1".into(),
                    routine_id: "rt-2".into(),
                    routine_name: "Digest".into(),
                },
                _ => ChatStart::Proposed { routine_id: "rt-1".into(), routine_name: "PR Review".into() },
            })
        })
    }
}

impl eos_core::routine::ArchitectTools for RunCalls {
    fn get_routine<'a>(&'a self, worker_id: &'a str) -> eos_core::BoxFuture<'a, Result<Value, eos_core::Error>> {
        let read = self.record(worker_id, format!("get {worker_id}"));
        Box::pin(async move { read.await.map(|()| serde_json::json!({"name": "PR Review"})) })
    }

    fn propose_blueprint<'a>(
        &'a self,
        worker_id: &'a str,
        blueprint: Value,
        note: Option<String>,
    ) -> eos_core::BoxFuture<'a, Result<eos_core::routine::Proposal, eos_core::Error>> {
        use eos_contracts::{BlueprintIssue, IssueSeverity};
        let issue =
            |path: &str, severity| BlueprintIssue { path: vec![path.into()], message: "Required".into(), severity };
        let answer = if blueprint["name"].is_string() {
            eos_core::routine::Proposal::Drafted {
                version_id: "rv-2".into(),
                warnings: vec![issue("summary", IssueSeverity::Warning)],
            }
        } else {
            eos_core::routine::Proposal::Refused(vec![
                issue("name", IssueSeverity::Error),
                issue("summary", IssueSeverity::Warning),
            ])
        };
        let written = self.record(worker_id, format!("propose {worker_id} {blueprint} {note:?}"));
        Box::pin(async move { written.await.map(|()| answer) })
    }

    fn ask_choice<'a>(
        &'a self,
        worker_id: &'a str,
        question: &'a str,
        choices: &'a [String],
    ) -> eos_core::BoxFuture<'a, Result<(), eos_core::Error>> {
        self.record(worker_id, format!("ask {worker_id} {question} {choices:?}"))
    }

    fn find_past_items<'a>(
        &'a self,
        worker_id: &'a str,
        limit: usize,
    ) -> eos_core::BoxFuture<'a, Result<Vec<eos_contracts::ItemRef>, eos_core::Error>> {
        let read = self.record(worker_id, format!("past {worker_id} {limit}"));
        Box::pin(async move { read.await.map(|()| Vec::new()) })
    }

    fn start_trial<'a>(&'a self, worker_id: &'a str) -> eos_core::BoxFuture<'a, Result<Vec<String>, eos_core::Error>> {
        let started = self.record(worker_id, format!("trial {worker_id}"));
        Box::pin(async move { started.await.map(|()| vec!["rn-1".to_owned(), "rn-2".to_owned()]) })
    }
}

pub(crate) fn bench(features: Arc<FakeFeatures>) -> Bench {
    bench_over(features, TempStore::new())
}

/// The registry over a database a test filled.
pub(crate) fn bench_over(features: Arc<FakeFeatures>, store: TempStore) -> Bench {
    bench_with(features, store, Vec::new(), FakeCapabilitySecrets::new())
}

/// The registry with these built-in capabilities and capability secrets.
pub(crate) fn bench_with(
    features: Arc<FakeFeatures>,
    store: TempStore,
    builtins: Vec<Arc<dyn BuiltinCapability>>,
    secrets: FakeCapabilitySecrets,
) -> Bench {
    let clock = Arc::new(FakeClock::new());
    let runner = Arc::new(FakeActionRunner::new());
    let trash = Arc::new(FakeTrash::new(store.home.join("trash")));
    let capabilities = Arc::new(CapabilityService::new(
        CapabilityPorts {
            store: store.port(),
            files: Arc::new(FakeCapabilityFiles::new(store.home.join("capabilities"), trash)),
            secrets: Arc::new(secrets),
            grants: Arc::new(AllInstalled),
            runner: Some(runner.clone()),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
        },
        builtins,
    ));
    let definitions = Arc::new(WorkerDefinitions::new(
        Arc::new(FsWorkerDefinitionFiles::new(store.home.path().join("workers"))),
        store.port(),
        clock.clone(),
    ));
    let runs = RunCalls::default();
    let tools = Tools::new(Services {
        prompts: Arc::new(PromptRegistry::new(Arc::new(LibraryPromptSource::embedded()))),
        clock: clock.clone(),
        sleeper: Arc::new(Skip(clock.clone())),
        zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
        store: store.port(),
        models: Arc::new(FakeModelCatalog::default()),
        definitions,
        workers: features.clone(),
        notifier: features.clone(),
        questions: features.clone(),
        pages: features.clone(),
        memory_search: features.clone(),
        memory_suggestions: features.clone(),
        experience: Some(features.clone()),
        plugins: features.clone(),
        browser: Some(features.clone()),
        visual: Some(Visual { answers: features.clone(), places: features.clone(), location: features.clone() }),
        peers: Some(features.clone()),
        transfers: Some(features.clone()),
        reactions: Some(features.clone()),
        capabilities: Some(capabilities.clone()),
        routines: Some(Arc::new(runs.clone())),
        architect: Some(Arc::new(runs.clone())),
        chat_routines: Some(Arc::new(runs.clone())),
        surfaces: Some(Arc::new(runs.clone())),
        forge: Some(Arc::new(runs.clone())),
    });
    Bench { tools, runs, features, clock, store, capabilities, runner }
}

fn session(role: SessionFactsRole, collaborate: bool) -> LaunchSpec {
    LaunchSpec { role, collaborate, ..LaunchSpec::new("w-self0001", "/repo/app", "sonnet") }
}

/// A routine's session, which starts focused as its reserved definition.
pub(crate) fn run_session(definition: &str) -> LaunchSpec {
    LaunchSpec { worker_definition: Some(definition.into()), ..session(SessionFactsRole::Focused, false) }
}

/// The session kinds of the vectors.
pub(crate) fn session_of(kind: &str) -> LaunchSpec {
    match kind {
        "orchestrator" => session(SessionFactsRole::Orchestrator, false),
        "worker" => session(SessionFactsRole::Worker, false),
        "peer" => session(SessionFactsRole::Worker, true),
        "focused" => session(SessionFactsRole::Focused, false),
        "focused-peer" => session(SessionFactsRole::Focused, true),
        "run-lead" => run_session("eos-run-solo"),
        "run-team-lead" => run_session("eos-run-lead"),
        "run-checker" => run_session("eos-run-checker"),
        "run-designer" => run_session("eos-run-designer"),
        "app-reviewer" => run_session("app-reviewer"),
        "architect" => run_session("eos-architect"),
        "run-forge" => LaunchSpec { worker_definition: Some("forge-builder".into()), ..session_of("worker") },
        other => panic!("unknown session kind {other}"),
    }
}

impl Bench {
    /// The tools a run session of `definition` gets, by name.
    pub(crate) fn names_of(&self, definition: &str) -> Vec<String> {
        self.tools.for_session(&run_session(definition)).iter().map(|tool| tool.definition().name.clone()).collect()
    }

    /// The tools a session of `kind` gets, by name.
    pub(crate) fn names(&self, kind: &str) -> Vec<String> {
        self.tools.for_session(&session_of(kind)).iter().map(|tool| tool.definition().name.clone()).collect()
    }

    /// The tool as a session of `kind` gets it.
    pub(crate) fn tool(&self, kind: &str, bare: &str) -> Arc<dyn HostTool> {
        self.tools
            .for_session(&session_of(kind))
            .into_iter()
            .find(|tool| tool.definition().name == bare)
            .unwrap_or_else(|| panic!("a {kind} session has no {bare}"))
    }

    /// Any session kind that has the tool.
    pub(crate) fn any_tool(&self, bare: &str) -> Arc<dyn HostTool> {
        let has = |kind: &str| self.tools.for_session(&session_of(kind)).iter().any(|t| t.definition().name == bare);
        let kinds = ["orchestrator", "focused-peer", "run-team-lead", "architect", "run-forge", "app-reviewer"];
        let kind = kinds.into_iter().find(|kind| has(kind)).unwrap_or("run-checker");
        self.tool(kind, bare)
    }
}

pub(crate) async fn call(tool: &Arc<dyn HostTool>, self_id: &str, input: Value) -> ToolReply {
    tool.call(ToolCaller { worker_id: self_id, call_id: "toolu_test", subagent_id: None }, input).await
}

#[test]
fn every_session_kind_gets_todays_tools_in_todays_order() {
    let registry = fixture("tools/registry.json");
    let bench = bench(FakeFeatures::new([]));
    for set in registry["sets"].as_array().expect("sets") {
        let off: Vec<String> = serde_json::from_value(set["pluginsOff"].clone()).expect("ids");
        *bench.features.plugins_off.lock().expect("plugins off") = off.clone();
        let kind = set["kind"].as_str().expect("kind");
        let names: Vec<String> =
            bench.tools.for_session(&session_of(kind)).iter().map(|tool| tool.definition().name.clone()).collect();
        let expected: Vec<String> = serde_json::from_value(set["names"].clone()).expect("names");
        assert_eq!(names, expected, "{kind} with {off:?} off");
    }
}

#[test]
fn a_git_worker_is_a_worker_and_a_sub_worker_gets_what_its_parent_kind_gets() {
    let bench = bench(FakeFeatures::new([]));
    let names = |spec: &LaunchSpec| -> Vec<String> {
        bench.tools.for_session(spec).iter().map(|tool| tool.definition().name.clone()).collect()
    };
    let worker = names(&session(SessionFactsRole::Worker, false));
    assert_eq!(names(&session(SessionFactsRole::Git, false)), worker);
    let sub = LaunchSpec { parent_id: Some("w-parent01".into()), ..session(SessionFactsRole::Worker, false) };
    assert_eq!(names(&sub), worker);
}

#[test]
fn each_tool_is_described_to_the_model_as_today() {
    let registry = fixture("tools/registry.json");
    let descriptions = fixture("prompts/library.json");
    let bench = bench(FakeFeatures::new([]));
    for tool in registry["tools"].as_array().expect("tools") {
        let name = tool["name"].as_str().expect("name");
        let ours = bench.any_tool(name);
        let definition = ours.definition();
        assert_eq!(definition.input_schema, tool["inputSchema"], "{name}: input schema");
        assert_eq!(
            definition.description,
            descriptions["toolDescriptions"][name].as_str().expect("a description"),
            "{name}: description"
        );
        assert_eq!(definition.deferred, !tool["alwaysLoad"].as_bool().expect("alwaysLoad"), "{name}: deferred");
        assert_eq!(definition.search_hint.as_deref(), tool["searchHint"].as_str(), "{name}: search hint");
        assert!(definition.main_agent_only, "{name}: not for subagents");
    }
}

/// Besides `call_capability`, which the gate decides by the class of the
/// action it calls.
#[test]
fn every_tool_is_one_the_permission_gate_knows_as_eos_own() {
    use eos_contracts::tool_scope::{CALL_CAPABILITY_TOOL, EOS_CONTROL_TOOLS, is_browser_tool, is_eos_control_tool};
    let bench = bench(FakeFeatures::new([]));
    let kinds = [
        "orchestrator",
        "focused-peer",
        "run-team-lead",
        "run-checker",
        "run-designer",
        "architect",
        "run-forge",
        "app-reviewer",
    ];
    let mut names: Vec<String> = kinds
        .iter()
        .flat_map(|kind| bench.tools.for_session(&session_of(kind)))
        .map(|tool| tool.definition().name.clone())
        .collect();
    names.sort();
    names.dedup();
    assert!(names.iter().any(|name| name == CALL_CAPABILITY_TOOL) && !is_eos_control_tool(CALL_CAPABILITY_TOOL));
    names.retain(|name| name != CALL_CAPABILITY_TOOL);
    for name in &names {
        assert!(is_eos_control_tool(name), "{name} is not in eos-contracts' list");
    }
    let listed = names.iter().filter(|name| !is_browser_tool(name)).count();
    assert_eq!(listed, EOS_CONTROL_TOOLS.len(), "eos-contracts lists a tool no session gets");
}

#[test]
fn every_agents_chat_gets_the_capability_tools() {
    let bench = bench(FakeFeatures::new([]));
    let capability_tools = |names: Vec<String>| -> Vec<String> {
        let reaching = |name: &String| name.ends_with("_capability") || name.ends_with("_capabilities");
        names.into_iter().filter(reaching).filter(|name| name != "request_capability").collect()
    };
    for kind in ["orchestrator", "worker", "focused"] {
        assert_eq!(capability_tools(bench.names(kind)), ["list_capabilities", "call_capability"], "{kind}");
    }
}

/// A run's lead is keyed on its reserved definition: its run tools, a
/// question for the user, the date, memory search and the capability tools; nothing of a chat's that reaches people or
/// machines.
#[test]
fn a_runs_lead_gets_its_own_list_whatever_kind_of_session_it_is() {
    let bench = bench(FakeFeatures::new([]));
    let lead = [
        "report_progress",
        "submit_result",
        "complete_milestone",
        "report_failure",
        "return_view",
        "fill_page",
        "app_propose",
        "ask_user",
        "current_datetime",
        "search_memory",
        "list_capabilities",
        "call_capability",
    ];
    let team = ["start_specialist", "message_specialist", "stop_specialist", "list_specialists"];
    let team_lead: Vec<&str> = lead[..4].iter().chain(&team).chain(&lead[4..]).copied().collect();
    for (definition, expected) in
        [("eos-run-solo", lead.to_vec()), ("eos-run-lead", team_lead), ("eos-run-script", lead.to_vec())]
    {
        let names = |spec: &LaunchSpec| -> Vec<String> {
            bench.tools.for_session(spec).iter().map(|tool| tool.definition().name.clone()).collect()
        };
        assert_eq!(names(&run_session(definition)), expected, "{definition}");
        let as_worker = LaunchSpec { worker_definition: Some(definition.into()), ..session_of("peer") };
        assert_eq!(names(&as_worker), expected, "{definition}: the definition decides, not the role");
    }
    let designer: Vec<&str> = ["page_design_read", "page_design_propose"]
        .iter()
        .chain(&lead[..4])
        .chain(&["current_datetime", "search_memory"])
        .copied()
        .collect();
    assert_eq!(bench.names_of("eos-run-designer"), designer, "a designer neither fills, returns nor sends");
    // A specialist is a worker of its own definition and keeps the worker list.
    let specialist = LaunchSpec { worker_definition: Some("eos-run-specialist".into()), ..session_of("worker") };
    assert_eq!(
        bench.tools.for_session(&specialist).iter().map(|t| t.definition().name.clone()).collect::<Vec<_>>(),
        bench.names("worker")
    );
    let lead = bench.names("run-lead");
    assert_eq!(lead[10..], ["list_capabilities", "call_capability"]);
    for never in
        ["send_to_machine", "ask_peer", "respond_to_peer", "list_peers", "notify_user", "present_app", "read_page"]
    {
        assert!(!lead.iter().any(|name| name == never), "{never}");
    }
    // A chat never gets a run's tools.
    for kind in ["orchestrator", "worker", "focused", "focused-peer"] {
        let names = bench.names(kind);
        assert!(!names.iter().any(|name| name == "submit_result"), "{kind}");
    }
    // The App's reviewer only gives its verdict.
    assert_eq!(bench.names_of("app-reviewer"), ["app_review", "current_datetime"]);
    // A checker session in the data only reads; it hands in nothing and asks nobody.
    assert_eq!(
        bench.names("run-checker"),
        ["current_datetime", "search_memory", "list_capabilities", "call_capability"]
    );
}

#[tokio::test]
async fn a_run_hands_back_a_view_and_reads_every_problem_at_once() {
    let bench = bench(FakeFeatures::new([]));
    let view = serde_json::json!({"place": "result", "view": {"title": "Digest"}});
    let returned = call(&bench.tool("run-team-lead", "return_view"), "w-lead", view).await;
    assert_eq!((returned.text.as_str(), returned.is_error), ("issue si-000000000001 · 0 bound actions", false));
    assert_eq!(*bench.runs.0.lock().expect("calls"), [r#"view w-lead result {"title":"Digest"}"#]);
    let bad = serde_json::json!({"place": "question", "view": {}, "bindings": {"go": {"action": "x"}}});
    let refused = call(&bench.tool("run-lead", "return_view"), "w-lead", bad).await;
    assert!(refused.is_error);
    assert_eq!(refused.text, "view.ui: is required\nbindings.go: binds no send action of the view");
    let elsewhere =
        call(&bench.tool("run-lead", "return_view"), "w-lead", serde_json::json!({"place": "aside", "view": {}})).await;
    assert!(elsewhere.is_error, "{}", elsewhere.text);
    // The facts of its options and its notes go to the surfaces beside the View, each fact
    // as its label and value only.
    let decision = serde_json::json!({"place": "result", "view": {"title": "Pick"},
        "facts": [{"option": "Free", "rows": [{"label": "Cost", "value": "None", "href": "https://evil.example"}]}],
        "aside": [{"title": "Why", "text": "Because."}]});
    let returned = call(&bench.tool("run-lead", "return_view"), "w-lead", decision).await;
    assert!(!returned.is_error, "{}", returned.text);
    assert_eq!(
        bench.runs.0.lock().expect("calls").last().map(String::as_str),
        Some(
            r#"view w-lead result {"title":"Pick"} facts [{"option":"Free","rows":[{"label":"Cost","value":"None"}]}] aside [{"title":"Why","text":"Because."}]"#
        )
    );
}

#[tokio::test]
async fn an_apps_reviewer_hands_its_verdict_to_surfaces_as_given() {
    let bench = bench(FakeFeatures::new([]));
    let verdict = serde_json::json!({"verdict": "pass", "findings": []});
    let answered = call(&bench.tool("app-reviewer", "app_review"), "w-reviewer", verdict).await;
    assert_eq!((answered.text.as_str(), answered.is_error), ("review recorded", false));
    assert_eq!(*bench.runs.0.lock().expect("calls"), [r#"app review w-reviewer {"verdict":"pass","findings":[]}"#]);
}

#[tokio::test]
async fn a_run_fills_its_page_with_data_or_asks_for_the_contract() {
    let bench = bench(FakeFeatures::new([]));
    let filled =
        call(&bench.tool("run-lead", "fill_page"), "w-lead", serde_json::json!({"data": {"title": "Hi"}})).await;
    assert_eq!((filled.text.as_str(), filled.is_error), ("issue si-000000000002 accepted", false));
    let asked = call(&bench.tool("run-lead", "fill_page"), "w-lead", serde_json::json!({})).await;
    assert!(!asked.is_error);
    assert_eq!(*bench.runs.0.lock().expect("calls"), [r#"page w-lead {"title":"Hi"}"#, "page w-lead null"]);
}

#[tokio::test]
async fn the_run_tools_hand_the_call_to_the_routines_feature() {
    let bench = bench(FakeFeatures::new([]));
    let progress =
        call(&bench.tool("run-lead", "report_progress"), "w-lead", serde_json::json!({"line": "Reading"})).await;
    assert_eq!((progress.text.as_str(), progress.is_error), ("Noted.", false));
    let result = serde_json::json!({"kind": "github.review", "headline": "Two issues", "body": {"summary": "s"}});
    let submitted = call(&bench.tool("run-lead", "submit_result"), "w-lead", result).await;
    assert!(!submitted.is_error && submitted.ends_turn, "{}", submitted.text);
    let milestone = serde_json::json!({"key": "m1", "summary": "Login screen done.", "files": ["login.png"]});
    let handed = call(&bench.tool("run-lead", "complete_milestone"), "w-lead", milestone).await;
    assert!(!handed.is_error && handed.ends_turn, "{}", handed.text);
    let failed =
        call(&bench.tool("run-lead", "report_failure"), "w-lead", serde_json::json!({"reason": "Closed."})).await;
    assert!(!failed.is_error && failed.ends_turn);
    assert_eq!(
        *bench.runs.0.lock().expect("calls"),
        [
            "progress w-lead Reading None",
            r#"result w-lead github.review Two issues {"summary":"s"} []"#,
            r#"milestone w-lead m1 Login screen done. ["login.png"]"#,
            "failure w-lead Closed."
        ]
    );
    let refused = call(&bench.tool("run-lead", "report_failure"), "w-none", serde_json::json!({"reason": "x"})).await;
    assert_eq!(
        (refused.text.as_str(), refused.is_error),
        (r#"daemon 409: {"error":"this session works for no run"}"#, true)
    );
}

#[tokio::test]
async fn a_team_leads_tools_hand_the_call_to_the_routines_feature() {
    let bench = bench(FakeFeatures::new([]));
    let tool = |name: &str| bench.tool("run-team-lead", name);
    let started =
        call(&tool("start_specialist"), "w-lead", serde_json::json!({"agent": "tester", "task": "Run it."})).await;
    assert_eq!(
        (started.text.as_str(), started.is_error),
        ("tester started. Its report comes to you as a message.", false)
    );
    let sent =
        call(&tool("message_specialist"), "w-lead", serde_json::json!({"agent": "tester", "text": "More."})).await;
    assert_eq!(sent.text, "Sent to tester.");
    let stopped = call(&tool("stop_specialist"), "w-lead", serde_json::json!({"agent": "tester"})).await;
    assert_eq!(stopped.text, "tester stopped.");
    let listed = call(&tool("list_specialists"), "w-lead", serde_json::json!({})).await;
    let rows: serde_json::Value = serde_json::from_str(&listed.text).expect("json");
    assert_eq!(
        rows,
        serde_json::json!([{"agent": "tester", "name": "Tester", "state": "working", "lastReport": null}])
    );
    assert_eq!(
        *bench.runs.0.lock().expect("calls"),
        ["start w-lead tester Run it.", "message w-lead tester More.", "stop w-lead tester", "list w-lead"]
    );
}

#[tokio::test]
async fn a_chat_starts_a_routine_only_when_it_lets_agents_and_proposes_it_otherwise() {
    let bench = bench(FakeFeatures::new([]));
    let run = bench.tool("orchestrator", "run_routine");
    let proposed = call(&run, "w-chat", serde_json::json!({"routine": "pr-review", "item": "482"})).await;
    let proposed: Value = serde_json::from_str(&proposed.text).expect("json");
    assert_eq!((proposed["state"].as_str(), proposed["routineId"].as_str()), (Some("proposed"), Some("rt-1")));
    let started = call(&run, "w-chat", serde_json::json!({"routine": "digest", "showOnly": true})).await;
    let started: Value = serde_json::from_str(&started.text).expect("json");
    assert_eq!((started["state"].as_str(), started["link"].as_str()), (Some("started"), Some("eos://runs/rn-1")));
    let listed = call(&bench.tool("architect", "list_routines"), "w-arch", serde_json::json!({})).await;
    let rows: Value = serde_json::from_str(&listed.text).expect("json");
    assert_eq!(rows[0]["slug"], "pr-review");
    assert_eq!(rows[0]["agentsMayStart"], false);
    assert_eq!(
        *bench.runs.0.lock().expect("calls"),
        [
            r#"run w-chat ChatRunAsk { routine: "pr-review", item: Some("482"), note: None, show_only: false }"#,
            r#"run w-chat ChatRunAsk { routine: "digest", item: None, note: None, show_only: true }"#,
        ]
    );
    assert!(bench.tools.for_session(&session_of("focused-peer")).iter().any(|t| t.definition().name == "run_routine"));
}

#[test]
fn sessions_with_the_same_tools_share_them() {
    let bench = bench(FakeFeatures::new([]));
    let first = bench.tools.for_session(&session_of("worker"));
    let second = bench.tools.for_session(&session_of("peer"));
    for (a, b) in first.iter().zip(&second) {
        assert!(Arc::ptr_eq(a, b), "{} is built once", a.definition().name);
    }
    // An orchestrator's tool is the worker's of the same name.
    assert!(Arc::ptr_eq(&bench.tool("orchestrator", "read_page"), &bench.tool("worker", "read_page")));
}

#[test]
fn a_feature_that_is_not_in_the_app_leaves_its_tools_out() {
    let features = FakeFeatures::new([]);
    let full = bench(features.clone());
    let store = TempStore::new();
    let clock = Arc::new(FakeClock::new());
    let tools = Tools::new(Services {
        prompts: Arc::new(PromptRegistry::new(Arc::new(LibraryPromptSource::embedded()))),
        clock: clock.clone(),
        sleeper: Arc::new(FakeSleeper::default()),
        zone: Arc::new(FakeTimeZone::new("UTC", 0)),
        store: store.port(),
        models: Arc::new(FakeModelCatalog::default()),
        definitions: Arc::new(WorkerDefinitions::new(
            Arc::new(FsWorkerDefinitionFiles::new(store.home.path().join("workers"))),
            store.port(),
            clock,
        )),
        workers: features.clone(),
        notifier: features.clone(),
        questions: features.clone(),
        pages: features.clone(),
        memory_search: features.clone(),
        memory_suggestions: features.clone(),
        experience: None,
        plugins: features.clone(),
        browser: None,
        visual: None,
        peers: None,
        transfers: None,
        reactions: None,
        capabilities: None,
        routines: None,
        architect: None,
        chat_routines: None,
        surfaces: None,
        forge: None,
    });
    let names = |tools: &Tools, kind: &str| -> Vec<String> {
        tools.for_session(&session_of(kind)).iter().map(|tool| tool.definition().name.clone()).collect()
    };
    let bare = names(&tools, "focused-peer");
    assert!(!bare.iter().any(|n| n.contains("browser_") || n.contains("present") || n.contains("peer")), "{bare:?}");
    assert!(!bare.iter().any(|n| n.ends_with("send_to_machine") || n.ends_with("find_places")), "{bare:?}");
    assert!(!bare.iter().any(|n| n.contains("capabilit")), "{bare:?}");
    // What is left keeps its order.
    let all = names(&full.tools, "focused-peer");
    let kept: Vec<String> = all.into_iter().filter(|n| bare.contains(n)).collect();
    assert_eq!(bare, kept);
}

#[tokio::test]
async fn a_bad_input_is_refused_in_the_words_agents_read_today() {
    let cases = fixture("tools/validation.json");
    let bench = bench(FakeFeatures::new([]));
    let mut tools = std::collections::HashMap::new();
    let (mut refused, mut accepted) = (0, 0);
    for case in cases.as_array().expect("cases") {
        let (name, label) = (case["tool"].as_str().expect("tool"), case["case"].as_str().expect("case"));
        let spec = [&bench.tools.orchestrator, &bench.tools.worker, &bench.tools.peer, &bench.tools.focused]
            .into_iter()
            .flatten()
            .find(|spec| spec.name == name)
            .unwrap_or_else(|| panic!("no tool {name}"));
        match case.get("error") {
            Some(error) => {
                let tool = tools.entry(name).or_insert_with(|| bench.any_tool(name));
                let reply = call(tool, "w-self0001", case["input"].clone()).await;
                assert!(reply.is_error, "{name} / {label}: refused");
                assert_eq!(reply.text, error.as_str().expect("text"), "{name} / {label}");
                refused += 1;
            }
            None => {
                let parsed = spec.input.parse(&case["input"]).unwrap_or_else(|issues| {
                    panic!("{name} / {label}: accepted today, refused here: {}", Value::Array(issues))
                });
                // The same keys, in the same order, with the defaults filled in.
                assert_eq!(parsed.to_string(), case["parsed"].to_string(), "{name} / {label}");
                accepted += 1;
            }
        }
    }
    assert!(refused > 500 && accepted > 150, "{refused} refused, {accepted} accepted");
}

/// A wait that is over at once and moves the clock by its length.
struct Skip(Arc<FakeClock>);

impl eos_core::Sleeper for Skip {
    fn sleep(&self, ms: i64) -> eos_core::BoxFuture<'static, ()> {
        self.0.advance(ms);
        Box::pin(std::future::ready(()))
    }
}

/// Where a tool's request to its feature can be held to the body the
/// TypeScript handler sent: the scripted call, and the part of it to compare.
fn sent_request(tool: &str) -> Option<(&'static str, &'static str)> {
    Some(match tool {
        "spawn_worker" => ("spawn", ""),
        "find_places" => ("places", ""),
        "append_to_page" | "edit_page" | "set_page_task" => ("pages.edit", "/edit"),
        "suggest_memory" => ("memory.suggest", "/request"),
        "plugin_preview" => ("plugins.preview", "/request"),
        _ => return None,
    })
}

#[tokio::test]
async fn each_handler_answers_the_model_as_today() {
    let cases = fixture("tools/handlers.json");
    for case in cases.as_array().expect("cases") {
        let (name, label) = (case["tool"].as_str().expect("tool"), case["name"].as_str().expect("name"));
        let answers: Vec<(u16, Value)> = case["api"]
            .as_array()
            .expect("api")
            .iter()
            .map(|a| (a["status"].as_u64().map_or(200, |s| s as u16), a["body"].clone()))
            .collect();
        let features = FakeFeatures::in_folder(
            case["cwd"].as_str().expect("cwd"),
            case["gitRepo"].as_bool().expect("gitRepo"),
            answers,
        );
        let bench = bench(features);
        if let Some(now) = case["now"].as_i64() {
            bench.clock.set(now);
        }
        let reply = call(&bench.any_tool(name), case["selfId"].as_str().expect("selfId"), case["args"].clone()).await;
        assert_eq!(reply.text, case["result"]["text"].as_str().expect("text"), "{name} / {label}");
        assert_eq!(reply.is_error, case["result"]["isError"].as_bool().expect("isError"), "{name} / {label}");
        assert_eq!(bench.features.unasked(), 0, "{name} / {label}: every scripted answer was asked for");

        if let Some((op, part)) = sent_request(name) {
            let ours = bench.features.calls().into_iter().rev().find(|(called, _)| called == op);
            let theirs = case["calls"].as_array().expect("calls").last().and_then(|c| c.get("body"));
            if let (Some((_, asked)), Some(body)) = (ours, theirs) {
                assert_eq!(asked.pointer(part).expect("the request"), body, "{name} / {label}: the request");
            }
        }
    }
}

#[test]
fn the_date_and_time_read_as_today() {
    for case in fixture("tools/datetime.json").as_array().expect("cases") {
        let zone =
            FakeTimeZone::new(case["name"].as_str().expect("name"), case["offsetMinutes"].as_i64().expect("m") as i32);
        let ours = crate::time::current_datetime(case["epochMs"].as_i64().expect("ms"), &zone);
        assert_eq!(ours.to_string(), case["result"].to_string());
    }
}

#[tokio::test]
async fn the_tools_that_read_workers_answer_what_the_daemon_answered_for_the_same_rows() {
    for case in fixture("tools/seeded.json").as_array().expect("cases") {
        let (name, label) = (case["tool"].as_str().expect("tool"), case["name"].as_str().expect("name"));
        let bench = bench_over(FakeFeatures::new([]), TempStore::seeded("/sandbox"));
        if let Some(ask) = case.get("pending") {
            let text = |key: &str| ask[key].as_str().expect("text").replace('\'', "''");
            bench.store.exec(&format!(
                "INSERT INTO pending_permissions (id, worker_id, tool_name, input, created_at, expires_at, resolved) \
                 VALUES ('{}', '{}', '{}', '{}', {}, {}, 0)",
                text("id"),
                text("worker_id"),
                text("tool_name"),
                text("input"),
                ask["created_at"],
                ask["expires_at"],
            ));
        }
        let reply = call(&bench.any_tool(name), case["selfId"].as_str().expect("selfId"), case["args"].clone()).await;
        assert_eq!(reply.text, case["result"]["text"].as_str().expect("text"), "{name} / {label}");
        assert_eq!(reply.is_error, case["result"]["isError"].as_bool().expect("isError"), "{name} / {label}");
    }
}

#[tokio::test]
async fn a_worker_nobody_knows_and_a_long_prompt_read_as_the_routes_word_them() {
    let bench = bench_over(FakeFeatures::new([]), TempStore::seeded("/sandbox"));
    let unknown = call(&bench.any_tool("get_worker"), "o-ORCH", serde_json::json!({"id": "w-nope0000"})).await;
    assert_eq!(
        (unknown.text.as_str(), unknown.is_error),
        (r#"daemon 404: {"error":"worker not found: w-nope0000"}"#, true)
    );
    // An agent reads its own row.
    let own = call(&bench.any_tool("get_worker"), "o-ORCH", serde_json::json!({"id": "o-ORCH"})).await;
    assert!(!own.is_error && own.text.contains("\"parent_id\": null"), "{}", own.text);

    // The list carries the first hundred units of each prompt.
    let long = "é".repeat(150);
    bench.store.exec(&format!("UPDATE workers SET prompt = '{long}' WHERE id = 'w-KID2'"));
    let listed = call(&bench.any_tool("list_active_workers"), "o-ORCH", serde_json::json!({})).await;
    let rows: Value = serde_json::from_str(&listed.text).expect("json");
    assert_eq!(rows[0]["prompt"], "é".repeat(100));
}

#[tokio::test]
async fn an_orchestrator_lists_the_workers_it_may_start_and_defines_its_own() {
    let bench = bench_over(FakeFeatures::new([]), TempStore::seeded("/sandbox"));
    let recorded = |step: &str| eos_testkit::fixtures::recorded_response("33-settings", step)["json"].clone();

    let listed = call(&bench.any_tool("list_available_workers"), "o-ORCH", serde_json::json!({})).await;
    let entries: Value = serde_json::from_str(&listed.text).expect("json");
    assert_eq!(entries, recorded("worker-definitions-for-owner"));
    // Each entry in the route's order.
    let keys: Vec<&String> = entries[0].as_object().expect("an entry").keys().collect();
    assert_eq!(keys, ["name", "description", "whenToUse", "source"]);
    assert!(listed.text.starts_with("[\n  {\n    \"name\": "), "indented as the model reads it");

    let definition = serde_json::json!({
        "name": "doc-writer", "description": "Writes docs", "whenToUse": "For README changes",
        "body": "You write documentation.",
    });
    let created = call(&bench.any_tool("create_worker"), "o-ORCH", definition).await;
    assert_eq!((created.text.as_str(), created.is_error), ("{\n  \"name\": \"doc-writer\"\n}", false));
    let listed = call(&bench.any_tool("list_available_workers"), "o-ORCH", serde_json::json!({})).await;
    assert_eq!(serde_json::from_str::<Value>(&listed.text).expect("json"), recorded("worker-definitions-with-own"));
    // Another orchestrator does not see it.
    let other = call(&bench.any_tool("list_available_workers"), "o-OTHER", serde_json::json!({})).await;
    assert!(!other.text.contains("doc-writer"));

    // What the route refuses, the tool refuses in the route's words.
    let unnamed = serde_json::json!({"name": "", "body": "x"});
    let bad = call(&bench.any_tool("create_worker"), "o-ORCH", unnamed).await;
    let refusal = r#"daemon 400: {"error":"invalid request: name: String must contain at least 1 character(s)"}"#;
    assert_eq!((bad.text.as_str(), bad.is_error), (refusal, true));
}

#[tokio::test]
async fn an_agent_asks_the_forge_and_a_forge_session_reports_to_it() {
    let bench = bench(FakeFeatures::new([]));
    assert_eq!(bench.names("run-forge"), ["send_message_to_parent", "forge_report", "current_datetime"]);
    for kind in ["worker", "focused", "run-lead", "run-checker"] {
        assert!(!bench.names(kind).iter().any(|name| name.contains("forge") || name == "request_capability"), "{kind}");
    }
    let asked =
        call(&bench.tool("orchestrator", "request_capability"), "o-self0001", serde_json::json!({"need": "Text me"}))
            .await;
    assert_eq!(serde_json::from_str::<Value>(&asked.text).expect("json")["forgeRun"], "rn-forge");
    let setup =
        call(&bench.tool("architect", "request_capability"), "w-arch", serde_json::json!({"need": "github"})).await;
    assert_eq!(serde_json::from_str::<Value>(&setup.text).expect("json")["setup"], "Sign in to GitHub.");
    let report = bench.tool("run-forge", "forge_report");
    let kept = call(&report, "w-build", serde_json::json!({"stage": "build", "report": {"package": "p"}})).await;
    assert!(!kept.is_error, "{}", kept.text);
    let odd = call(&report, "w-build", serde_json::json!({"stage": "deploy", "report": {}})).await;
    assert!(odd.is_error, "{}", odd.text);
    let calls = bench.runs.0.lock().expect("calls").clone();
    assert_eq!(
        calls,
        ["forge o-self0001 Text me None", "forge w-arch github None", r#"report w-build build {"package":"p"}"#]
    );
}
