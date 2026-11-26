//! The prompt routes over the shipped library, against what the Node daemon
//! recorded (`33-settings`), with the profile block taken from the recording.
//! With the real profile feature behind them, the same steps are replayed
//! against the composed app (`scripts/replay.sh`).

use std::sync::Arc;

use eos_mod_prompts::PromptsModule;
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService, SessionSpawnContext, assemble_system_prompt};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::prompts::LibraryPromptSource;
use eos_testkit::{FakeProfileRenderer, fixtures};
use serde_json::Value;

fn prompts() -> Arc<PromptService> {
    let registry = Arc::new(PromptRegistry::new(Arc::new(LibraryPromptSource::embedded())));
    Arc::new(PromptService::new(registry, tool_name_vars()))
}

/// How the memory fragments (worker `10c`, orchestrator `12c`, focused `01`)
/// opened their rule line in the recording, and how they open it here: Eos
/// keeps a rule the user states by itself (`fixtures/wire/rust-differences.toml`).
const STATED_RULE: (&str, &str) = (
    "When the user states how agents should work with them from now on (\"from now on…\", \"always…\"), or makes \
     the same correction",
    "Eos keeps a rule the user states for how agents should work with them from now on (\"from now on…\", \
     \"always…\") by itself. When the user makes the same correction",
);

/// A recorded answer with the memory fragments' rule line as this app words it.
fn reworded(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(STATED_RULE.0, STATED_RULE.1)),
        Value::Array(list) => Value::Array(list.into_iter().map(reworded).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, reworded(value))).collect()),
        other => other,
    }
}

/// The profile block inside the recorded preview: what stands where the
/// worker preamble has `{{USER_PROFILE}}`. The block itself is the profile
/// feature's to render; here it comes from the TypeScript's own answer, so
/// the comparison judges everything around it.
fn recorded_profile(prompts: &PromptService) -> String {
    const MARK: &str = "\u{1}profile\u{1}";
    let ctx: SessionSpawnContext = serde_json::from_value(serde_json::json!({
        "role": "worker", "name": "preview", "model": "high", "permissionMode": "bypassPermissions", "userProfile": MARK
    }))
    .expect("a context");
    let ours = assemble_system_prompt(prompts, &ctx, Vec::new()).text;
    let (before, after) = ours.split_once(MARK).expect("the preamble shows the profile");
    let recorded = reworded(fixtures::recorded_response("33-settings", "prompt-preview"));
    let text = recorded["json"]["text"].as_str().expect("the recorded text");
    let profile = text.strip_prefix(before).and_then(|rest| rest.strip_suffix(after));
    profile.expect("the recorded preview is ours around the profile block").to_owned()
}

/// Prompts of features the TypeScript app did not have: the capability tools,
/// reactions, a focused chat's subagent models, memory's reflection and
/// recall, and routines with their lead, checker, specialists, pages, apps,
/// signals and the Forge.
const ADDED: &[&str] = &[
    "tool/call_capability",
    "tool/list_capabilities",
    "reactions",
    "tool/react",
    "tool/no_reply",
    "role/focused/06-models",
    "memory/generalize-system",
    "memory/generalize",
    "memory/playbook-system",
    "memory/playbook",
    "memory/reflect-system",
    "memory/reflect",
    "micro-tasks/signal-match",
    "role/focused/20-routine-architect",
    "role/focused/21-routine-lead",
    "role/focused/23-routine-designer",
    "role/worker/20-routine-specialist",
    "routine/architect-change",
    "routine/architect-make",
    "routine/design-brief",
    "routine/intent-system",
    "routine/intent",
    "routine/once-blueprint-system",
    "routine/once-blueprint",
    "routine/run-brief",
    "routine/specialist-brief",
    "routine/suggest",
    "tool/app_propose",
    "tool/app_review",
    "tool/ask_choice",
    "tool/complete_milestone",
    "tool/fill_page",
    "tool/find_past_items",
    "tool/forge_report",
    "tool/get_routine",
    "tool/list_routines",
    "tool/list_specialists",
    "tool/message_specialist",
    "tool/page_design_propose",
    "tool/page_design_read",
    "tool/propose_blueprint",
    "tool/recall_experience",
    "tool/report_failure",
    "tool/report_progress",
    "tool/request_capability",
    "tool/return_view",
    "tool/run_routine",
    "tool/start_specialist",
    "tool/start_trial",
    "tool/stop_specialist",
    "tool/submit_result",
];

/// A recorded answer as this app gives it: the catalog without the goal loop's
/// prompts, the one sent after an account switch and the separate summarizer's,
/// which it does not ship, with compaction's own words (`ours`: a session
/// summarizes inside its conversation), and with the prompts of its own tools
/// where it lists them (`fixtures/wire/rust-differences.toml`).
fn shipped(mut recorded: Value, ours: &Value) -> Value {
    let gone = |id: &str| {
        id.starts_with("loop/")
            || id == "tool/dynamic_loop"
            || id == "accounts/continue"
            || id == "compaction/summarizer-system"
    };
    let own = |id: &str| {
        let list = ours["prompts"].as_array().into_iter().flatten();
        list.into_iter().find(|p| p["id"] == id).cloned().unwrap_or_else(|| panic!("{id} is shipped"))
    };
    if let Some(list) = recorded.get_mut("prompts").and_then(Value::as_array_mut) {
        list.retain(|p| p["id"].as_str().is_some_and(|id| !gone(id)));
        for prompt in list.iter_mut() {
            if let Some(id) = prompt["id"].as_str().filter(|id| id.starts_with("compaction/")).map(str::to_owned) {
                *prompt = own(&id);
            }
        }
        let list_of_ours = ours["prompts"].as_array().into_iter().flatten().enumerate();
        for (at, prompt) in list_of_ours.filter(|(_, p)| p["id"].as_str().is_some_and(|id| ADDED.contains(&id))) {
            list.insert(at.min(list.len()), prompt.clone());
        }
    }
    recorded
}

async fn ask(app: &Runtime, method: Method, path: &str, body: Option<&str>) -> (u16, Value) {
    let mut request = Request::new(method, path, Caller::DASHBOARD);
    if let Some(body) = body {
        request = request.body(body.to_owned());
    }
    let res = app.router.handle(request).await;
    let bytes = res.body.collect().await.expect("a body");
    (res.status, serde_json::from_slice(&bytes).expect("json"))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_catalog_and_the_preview_answer_as_recorded() {
    let prompts = prompts();
    let profile = recorded_profile(&prompts);
    assert!(profile.starts_with("`<user_profile>`") && profile.contains("Sam"), "the seeded user's block");
    let module = Arc::new(PromptsModule::new(prompts, Some(Arc::new(FakeProfileRenderer::with_text(&profile)))));
    let app =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");

    for (step, method, path, body) in [
        ("prompts", Method::Get, "/api/prompts", None),
        ("prompt-preview", Method::Post, "/api/prompts/preview", Some(r#"{"role":"worker"}"#)),
        ("prompt-preview-invalid", Method::Post, "/api/prompts/preview", Some(r#"{"role":"king"}"#)),
    ] {
        let recorded = reworded(fixtures::recorded_response("33-settings", step));
        let (status, json) = ask(&app, method, path, body).await;
        assert_eq!(Value::from(status), recorded["status"], "{step}");
        assert_eq!(json, shipped(recorded["json"].clone(), &json), "{step}");
    }
    // No body at all is the default worker (`90-gates`).
    let recorded = reworded(fixtures::recorded_response("90-gates", "post-api-prompts-preview"));
    assert_eq!(ask(&app, Method::Post, "/api/prompts/preview", None).await.1, recorded["json"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_profile_renderer_only_the_catalog_is_offered() {
    let module = Arc::new(PromptsModule::new(prompts(), None));
    let app =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");
    assert_eq!(app.router.handle(Request::new(Method::Get, "/api/prompts", Caller::DASHBOARD)).await.status, 200);
    assert_eq!(
        app.router.handle(Request::new(Method::Post, "/api/prompts/preview", Caller::DASHBOARD)).await.status,
        404
    );
}
