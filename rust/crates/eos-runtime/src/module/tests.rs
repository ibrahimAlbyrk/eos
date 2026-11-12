use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use eos_core::agent::ToolInputPhase;

use super::*;
use crate::access::{Access, Caller};
use crate::bus::{ScopeKind, Topic};
use crate::http::{ApiError, Method, Request, Response};

async fn ok(_req: Request) -> Result<Response, ApiError> {
    Ok(Response::new(204))
}

/// A module described by data, for composing.
#[derive(Default)]
struct Fake {
    id: &'static str,
    plugin: Option<&'static str>,
    routes: Vec<(&'static str, &'static str)>,
    topics: Vec<&'static str>,
    kinds: Vec<&'static str>,
    hooks: Vec<(&'static str, i32)>,
    commands: Vec<&'static str>,
    keys: Vec<&'static str>,
    domains: Vec<&'static str>,
    variables: Vec<(&'static str, PromptValue)>,
    follows: Option<&'static str>,
    holds: Option<&'static str>,
    panics: bool,
    heard: Mutex<Vec<String>>,
}

impl Module for Fake {
    fn id(&self) -> &'static str {
        self.id
    }
    fn plugin(&self) -> Option<&'static str> {
        self.plugin
    }
    fn routes(&self) -> Vec<RouteDef> {
        self.routes
            .iter()
            .map(|(method, pattern)| {
                let route = if *method == "GET" { RouteDef::get(*pattern, ok) } else { RouteDef::post(*pattern, ok) };
                route.access(Access::open())
            })
            .collect()
    }
    fn topics(&self) -> Vec<TopicDecl> {
        self.topics.iter().map(|name| TopicDecl { name, scope: None }).collect()
    }
    fn job_kinds(&self) -> Vec<&'static str> {
        self.kinds.clone()
    }
    fn idle_hooks(&self) -> Vec<IdleHook> {
        self.hooks.iter().map(|(id, order)| IdleHook::new(id, *order, |_| false)).collect()
    }
    fn slash_commands(&self) -> Vec<SlashCommandDecl> {
        self.commands.iter().map(|name| SlashCommandDecl { name, command: Arc::new(()) }).collect()
    }
    fn protected_settings(&self) -> Option<ProtectedSettings> {
        (!self.keys.is_empty()).then(|| ProtectedSettings { keys: self.keys.clone(), via: "PUT /api/settings/x" })
    }
    fn sync(&self) -> Vec<SyncContribution> {
        self.domains
            .iter()
            .map(|domain| SyncContribution { domain, handle: Arc::new(()), change_topic: None, is_local: None })
            .collect()
    }
    fn prompt_variables(&self) -> Vec<(&'static str, PromptValue)> {
        self.variables.clone()
    }
    fn follows_tool_input(&self, tool: &str) -> bool {
        self.follows == Some(tool)
    }
    fn holds_worker(&self, worker_id: &str) -> bool {
        self.holds == Some(worker_id)
    }
    fn on_tool_input_delta(&self, worker_id: &str, delta: &ToolInputDelta) {
        self.heard.lock().expect("heard").push(format!("delta:{worker_id}:{}", delta.text));
    }
    fn on_agent_event(&self, worker_id: &str, event: &AgentEvent) {
        if self.panics {
            panic!("module bug");
        }
        self.heard.lock().expect("heard").push(format!("event:{worker_id}:{event:?}"));
    }
    fn on_session_ended(&self, session_key: &str) {
        self.heard.lock().expect("heard").push(format!("ended:{session_key}"));
    }
}

struct Switch(AtomicBool);
impl PluginSwitch for Switch {
    fn is_on(&self, _plugin: &str) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

fn all_on() -> Arc<dyn PluginSwitch> {
    Arc::new(crate::router::AllPluginsOn)
}

fn conflicts(modules: Vec<Fake>) -> Vec<String> {
    let modules = modules.into_iter().map(|m| Arc::new(m) as Arc<dyn Module>).collect();
    match compose(modules, all_on()) {
        Err(Error::Conflicts(list)) => list.iter().map(ToString::to_string).collect(),
        Ok(_) => Vec::new(),
        Err(other) => panic!("unexpected error: {other}"),
    }
}

#[test]
fn collects_what_every_module_contributes() {
    const PAGES_CHANGE: Topic<()> = Topic::new("pages:change");
    const GENUI_DELTA: Topic<()> = Topic::scoped("genui:delta", ScopeKind::Worker, |_| None);
    let pages = Fake {
        id: "pages",
        plugin: Some("eos.pages"),
        routes: vec![("GET", "/api/pages"), ("POST", "/api/pages/{id}/edit")],
        topics: vec![PAGES_CHANGE.name()],
        domains: vec!["pages"],
        ..Fake::default()
    };
    let compaction = Fake {
        id: "compaction",
        kinds: vec!["compaction"],
        hooks: vec![("compaction", 10)],
        commands: vec!["compact"],
        ..Fake::default()
    };
    let genui = Fake {
        id: "genui",
        topics: vec![GENUI_DELTA.name()],
        keys: vec!["genui.level", "location.share"],
        ..Fake::default()
    };
    let composed = compose(vec![Arc::new(pages), Arc::new(compaction), Arc::new(genui)], all_on()).expect("no clashes");

    assert_eq!(composed.modules.len(), 3);
    assert_eq!(composed.routes.iter().map(|r| r.pattern()).collect::<Vec<_>>(), ["/api/pages", "/api/pages/{id}/edit"]);
    assert_eq!(composed.topics.iter().map(|t| t.name).collect::<Vec<_>>(), ["pages:change", "genui:delta"]);
    assert_eq!(composed.job_kinds, ["shell", "compaction"]);
    assert_eq!(composed.idle_hooks.iter().map(|h| (h.id, h.order)).collect::<Vec<_>>(), [("compaction", 10)]);
    assert_eq!(composed.slash_commands.iter().map(|c| c.name).collect::<Vec<_>>(), ["compact"]);
    assert_eq!(composed.protected_settings[0].keys, ["genui.level", "location.share"]);
    assert_eq!(composed.sync.iter().map(|s| s.domain).collect::<Vec<_>>(), ["pages"]);
}

#[test]
fn reports_every_clash_between_modules() {
    let found = conflicts(vec![
        Fake {
            id: "a",
            routes: vec![("GET", "/api/things/{id}")],
            topics: vec!["things:change"],
            kinds: vec!["sync"],
            hooks: vec![("nudge", 10)],
            commands: vec!["compact"],
            keys: vec!["x.level"],
            domains: vec!["things"],
            ..Fake::default()
        },
        Fake {
            id: "b",
            routes: vec![("GET", "/api/things/{name}"), ("POST", "/api/things/{id}")],
            topics: vec!["things:change"],
            kinds: vec!["sync"],
            hooks: vec![("nudge", 20)],
            commands: vec!["compact"],
            keys: vec!["x.level"],
            domains: vec!["things"],
            ..Fake::default()
        },
        Fake { id: "a", ..Fake::default() },
    ]);
    assert_eq!(
        found,
        [
            "topic things:change is declared by a and by b",
            "job kind sync is declared by a and by b",
            "idle hook nudge is declared by a and by b",
            "slash command compact is declared by a and by b",
            "settings key x.level is declared by a and by b",
            "sync domain things is declared by a and by b",
            "module a is declared by a and by a",
            "route GET /api/things/{name} is declared by a (GET /api/things/{id}) and by b",
        ]
    );
}

#[test]
fn refuses_a_job_kind_the_wire_would_not_accept() {
    for bad in ["Sync", "", "9lives", "has space", "x".repeat(41).leak()] {
        let module = Fake { id: "a", kinds: vec![bad], ..Fake::default() };
        assert!(matches!(compose(vec![Arc::new(module)], all_on()), Err(Error::BadDeclaration { .. })), "{bad:?}");
    }
    let fine = Fake { id: "a", kinds: vec!["update-download", "x".repeat(40).leak()], ..Fake::default() };
    assert!(compose(vec![Arc::new(fine)], all_on()).is_ok());
}

#[tokio::test]
async fn a_modules_routes_follow_its_plugin_switch() {
    let switch = Arc::new(Switch(AtomicBool::new(false)));
    let pages = Fake { id: "pages", plugin: Some("eos.pages"), routes: vec![("GET", "/api/pages")], ..Fake::default() };
    let health = Fake { id: "health", routes: vec![("GET", "/health")], ..Fake::default() };
    let composed = compose(vec![Arc::new(pages), Arc::new(health)], switch.clone()).expect("no clashes");
    let router = Router::builder().plugins(switch.clone()).routes(composed.routes).build().expect("valid");
    assert_eq!(router.find(Method::Get, "/api/pages").expect("route").owner.as_ref(), "pages");
    assert_eq!(router.handle(Request::new(Method::Get, "/api/pages", Caller::DASHBOARD)).await.status, 404);
    assert_eq!(router.handle(Request::new(Method::Get, "/health", Caller::DASHBOARD)).await.status, 204);
    switch.0.store(true, Ordering::SeqCst);
    assert_eq!(router.handle(Request::new(Method::Get, "/api/pages", Caller::DASHBOARD)).await.status, 204);
}

#[test]
fn fans_calls_out_to_the_modules() {
    let switch = Arc::new(Switch(AtomicBool::new(false)));
    let artifacts = Arc::new(Fake { id: "artifacts", plugin: Some("eos.artifacts"), ..Fake::default() });
    let broken = Arc::new(Fake { id: "broken", panics: true, ..Fake::default() });
    let genui = Arc::new(Fake {
        id: "genui",
        follows: Some("present"),
        holds: Some("w-held"),
        variables: vec![("GENUI_LEVEL", PromptValue::Text("rich".into())), ("SHARED", PromptValue::Flag(false))],
        ..Fake::default()
    });
    let later = Arc::new(Fake { id: "later", variables: vec![("SHARED", PromptValue::Flag(true))], ..Fake::default() });
    let modules =
        compose(vec![artifacts.clone(), broken, genui.clone(), later], switch.clone()).expect("no clashes").modules;

    let event: AgentEvent =
        serde_json::from_value(serde_json::json!({ "type": "session", "phase": "started", "sessionId": "s-1" }))
            .expect("an agent event");
    modules.on_agent_event("w1", &event);
    assert!(artifacts.heard.lock().expect("heard").is_empty(), "a switched-off plugin hears no agent events");
    assert_eq!(genui.heard.lock().expect("heard").len(), 1, "a panicking module does not silence the next");
    switch.0.store(true, Ordering::SeqCst);
    modules.on_agent_event("w1", &event);
    assert_eq!(artifacts.heard.lock().expect("heard").len(), 1);

    assert!(modules.follows_tool_input("present"));
    assert!(!modules.follows_tool_input("Bash"));
    let piece = |name: &str, text: &str| ToolInputDelta {
        call_id: "call-1".into(),
        name: name.into(),
        phase: ToolInputPhase::Append,
        text: text.into(),
    };
    modules.on_tool_input_delta("w1", "present", &piece("present", "{"));
    modules.on_tool_input_delta("w1", "Bash", &piece("Bash", "ls"));
    assert_eq!(genui.heard.lock().expect("heard")[2], "delta:w1:{");
    assert_eq!(artifacts.heard.lock().expect("heard").len(), 1, "only the modules that follow the tool get its input");

    assert!(modules.holds_worker("w-held"));
    assert!(!modules.holds_worker("w1"));
    modules.on_session_ended("s1");
    assert_eq!(artifacts.heard.lock().expect("heard").last().map(String::as_str), Some("ended:s1"));
    assert_eq!(
        modules.prompt_variables(),
        [("GENUI_LEVEL", PromptValue::Text("rich".into())), ("SHARED", PromptValue::Flag(true))]
    );
}

#[test]
fn protected_settings_name_the_route_that_may_write_them() {
    let genui = ProtectedSettings { keys: vec!["genui.level", "location.share"], via: "PUT /api/settings/genui" };
    assert_eq!(genui.refusal(["theme"]), None);
    assert_eq!(
        genui.refusal(["theme", "location.share"]).as_deref(),
        Some("location.share is set only through PUT /api/settings/genui")
    );
    assert_eq!(
        genui.refusal(["location.share", "genui.level"]).as_deref(),
        Some("genui.level, location.share are set only through PUT /api/settings/genui")
    );
}

#[test]
fn a_kernel_job_kind_is_shared_without_a_clash() {
    // `!` commands and agents' background shells both produce `shell` jobs.
    let terminals = Fake { id: "terminals", kinds: vec!["shell"], ..Fake::default() };
    let engine = Fake { id: "engine", kinds: vec!["shell", "workflow"], ..Fake::default() };
    let composed = compose(vec![Arc::new(terminals), Arc::new(engine)], all_on()).expect("no clash over shell");
    assert_eq!(composed.job_kinds, ["shell", "workflow"]);
}
