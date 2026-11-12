//! The registry held to what the TypeScript registry gives agents
//! (`fixtures/tools`, written by `tools/tools-vectors`).

use std::sync::Arc;

use eos_contracts::SessionFactsRole;
use eos_core::agent::{HostTool, LaunchSpec, ToolCaller, ToolReply, ToolSets};
use eos_prompts::PromptRegistry;
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_testkit::{FakeClock, FakeFeatures, FakeModelCatalog, FakeSleeper, FakeTimeZone, TempStore};
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
}

pub(crate) fn bench(features: Arc<FakeFeatures>) -> Bench {
    bench_over(features, TempStore::new())
}

/// The registry over a database a test filled.
pub(crate) fn bench_over(features: Arc<FakeFeatures>, store: TempStore) -> Bench {
    let clock = Arc::new(FakeClock::new());
    let definitions = Arc::new(WorkerDefinitions::new(
        Arc::new(FsWorkerDefinitionFiles::new(store.home.path().join("workers"))),
        store.port(),
        clock.clone(),
    ));
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
        plugins: features.clone(),
        browser: Some(features.clone()),
        visual: Some(Visual { answers: features.clone(), places: features.clone(), location: features.clone() }),
        peers: Some(features.clone()),
        transfers: Some(features.clone()),
    });
    Bench { tools, features, clock, store }
}

fn session(role: SessionFactsRole, collaborate: bool) -> LaunchSpec {
    LaunchSpec { role, collaborate, ..LaunchSpec::new("w-self0001", "/repo/app", "sonnet") }
}

/// The session kinds of the vectors.
fn session_of(kind: &str) -> LaunchSpec {
    match kind {
        "orchestrator" => session(SessionFactsRole::Orchestrator, false),
        "worker" => session(SessionFactsRole::Worker, false),
        "peer" => session(SessionFactsRole::Worker, true),
        "focused" => session(SessionFactsRole::Focused, false),
        "focused-peer" => session(SessionFactsRole::Focused, true),
        other => panic!("unknown session kind {other}"),
    }
}

impl Bench {
    /// The tool as a session of `kind` gets it.
    pub(crate) fn tool(&self, kind: &str, bare: &str) -> Arc<dyn HostTool> {
        let wanted = format!("__{bare}");
        self.tools
            .for_session(&session_of(kind))
            .into_iter()
            .find(|tool| tool.definition().name.ends_with(&wanted))
            .unwrap_or_else(|| panic!("a {kind} session has no {bare}"))
    }

    /// Any session kind that has the tool.
    pub(crate) fn any_tool(&self, bare: &str) -> Arc<dyn HostTool> {
        let kind = if self
            .tools
            .for_session(&session_of("orchestrator"))
            .iter()
            .any(|t| t.definition().name.ends_with(&format!("__{bare}")))
        {
            "orchestrator"
        } else {
            "focused-peer"
        };
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

#[test]
fn sessions_with_the_same_tools_share_them() {
    let bench = bench(FakeFeatures::new([]));
    let first = bench.tools.for_session(&session_of("worker"));
    let second = bench.tools.for_session(&session_of("peer"));
    for (a, b) in first.iter().zip(&second) {
        assert!(Arc::ptr_eq(a, b), "{} is built once", a.definition().name);
    }
    // The same tool under the other server's name is another tool.
    let orchestrator = bench.tool("orchestrator", "read_page");
    assert_eq!(orchestrator.definition().name, "mcp__orchestrator__read_page");
    assert_eq!(bench.tool("worker", "read_page").definition().name, "mcp__worker__read_page");
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
        plugins: features.clone(),
        browser: None,
        visual: None,
        peers: None,
        transfers: None,
    });
    let names = |tools: &Tools, kind: &str| -> Vec<String> {
        tools.for_session(&session_of(kind)).iter().map(|tool| tool.definition().name.clone()).collect()
    };
    let bare = names(&tools, "focused-peer");
    assert!(!bare.iter().any(|n| n.contains("browser_") || n.contains("present") || n.contains("peer")), "{bare:?}");
    assert!(!bare.iter().any(|n| n.ends_with("send_to_machine") || n.ends_with("find_places")), "{bare:?}");
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
