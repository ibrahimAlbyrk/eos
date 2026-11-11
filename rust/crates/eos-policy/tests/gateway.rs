//! The gateway over the real store: what a decision leaves behind, and how an
//! ask waits and is released.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{ExternalDecision, PolicyBehavior, UnknownRecord, WorkerEventType};
use eos_core::Error;
use eos_core::policy::{DecisionCounter, DecisionCounts, PolicyDecider, ToolCall};
use eos_policy::{Answer, GatewayOptions, PolicyGateway};
use eos_testkit::{FakeClock, FakePolicyFile, SeqIds, TempStore};
use serde_json::{Value, json};

struct Fixture {
    gateway: Arc<PolicyGateway>,
    temp: TempStore,
    clock: Arc<FakeClock>,
    file: Arc<FakePolicyFile>,
}

/// One worker, `w1`, in `mode`, under a policy that asks by default.
fn fixture(mode: &str, policy: Value) -> Fixture {
    let temp = TempStore::new();
    temp.exec(&format!(
        "INSERT INTO workers (id, state, prompt, started_at, permission_mode) VALUES ('w1', 'IDLE', '', 1, '{mode}')"
    ));
    let clock = Arc::new(FakeClock::at(1000));
    let file = Arc::new(FakePolicyFile::holding(policy));
    let gateway = Arc::new(PolicyGateway::new(GatewayOptions {
        store: temp.port(),
        clock: clock.clone(),
        ids: Arc::new(SeqIds::new()),
        file: file.clone(),
        default_ttl_ms: 0,
        plans_dir: None,
    }));
    Fixture { gateway, temp, clock, file }
}

fn record(value: Value) -> UnknownRecord {
    serde_json::from_value(value).expect("an object")
}

fn call(tool: &str, input: Value) -> ToolCall {
    ToolCall::new("w1", tool, record(input))
}

fn behavior(decision: &ExternalDecision) -> &'static str {
    match decision {
        ExternalDecision::Allow(_) => "allow",
        ExternalDecision::Deny(_) => "deny",
    }
}

fn message(decision: &ExternalDecision) -> &str {
    match decision {
        ExternalDecision::Deny(deny) => &deny.message,
        ExternalDecision::Allow(_) => "",
    }
}

/// Waits until `n` asks are stored and their calls parked.
async fn parked(f: &Fixture, n: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while f.temp.announced.topics().iter().filter(|t| **t == "pending:created").count() != n {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the call parks");
    assert_eq!(f.gateway.waiting(), n);
}

fn ask_rule() -> Value {
    json!({"default": "ask", "ttlMs": 3000, "rules": []})
}

#[tokio::test(flavor = "multi_thread")]
async fn a_decision_is_logged_announced_and_counted() {
    let f = fixture("bypassPermissions", ask_rule());
    let decision = f.gateway.decide(call("Bash", json!({"command": "ls"}))).await.expect("decides");
    assert_eq!(
        serde_json::to_string(&decision).expect("json"),
        r#"{"behavior":"allow","updatedInput":{"command":"ls"}}"#
    );
    assert_eq!(
        f.temp.announced.list(),
        [("policy:decision", r#"{"workerId":"w1","tool":"Bash","behavior":"allow"}"#.to_owned())]
    );
    let events =
        f.temp.store.read_blocking(|tx| tx.events().list_by_type("w1", WorkerEventType::Policy, None)).expect("reads");
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].ts, events[0].payload.as_deref()), (1000, Some(r#"{"tool":"Bash","decision":"allow"}"#)));
    assert_eq!(f.gateway.decision_counts(), DecisionCounts { allow: 1, deny: 0, ask: 0 });
    assert_eq!(f.gateway.waiting(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mode_switch_gates_the_very_next_call() {
    let f = fixture("bypassPermissions", ask_rule());
    let first = f.gateway.decide(call("Bash", json!({"command": "ls"}))).await.expect("decides");
    assert_eq!(behavior(&first), "allow");
    assert_eq!(f.gateway.waiting(), 0, "full access asks nothing");

    f.temp.exec("UPDATE workers SET permission_mode = 'acceptEdits' WHERE id = 'w1'");
    let gateway = f.gateway.clone();
    let second = tokio::spawn(async move { gateway.decide(call("Bash", json!({"command": "ls"}))).await });
    parked(&f, 1).await;
    assert!(!second.is_finished(), "the call waits for the user");

    let open = f.temp.store.read_blocking(|tx| tx.pending().list_unresolved()).expect("reads");
    assert_eq!(open.len(), 1);
    assert_eq!((open[0].tool_name.as_str(), open[0].created_at, open[0].expires_at), ("Bash", 1000, 4000));
    assert_eq!(open[0].input, r#"{"command":"ls"}"#);

    // Back to full access: new calls pass, the parked one still waits.
    f.temp.exec("UPDATE workers SET permission_mode = 'bypassPermissions' WHERE id = 'w1'");
    let third = f.gateway.decide(call("Bash", json!({"command": "ls"}))).await.expect("decides");
    assert_eq!(behavior(&third), "allow");
    assert!(!second.is_finished());

    f.gateway.resolve(&open[0].id, Answer::Deny { reason: Some("user denied".into()) }).await.expect("resolves");
    let answered = second.await.expect("joins").expect("decides");
    assert_eq!((behavior(&answered), message(&answered)), ("deny", "user denied"));
    assert_eq!(f.gateway.waiting(), 0);
    assert_eq!(f.gateway.decision_counts(), DecisionCounts { allow: 2, deny: 0, ask: 1 });
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ask_leaves_a_row_two_events_and_its_announcements_in_order() {
    let f = fixture("acceptEdits", ask_rule());
    let gateway = f.gateway.clone();
    let mut asked = call("WebFetch", json!({"url": "https://x", "n": 2.0}));
    asked.tool_use_id = Some("call_1".into());
    let waiting = tokio::spawn(async move { gateway.decide(asked).await });
    parked(&f, 1).await;

    assert_eq!(
        f.temp.announced.list(),
        [
            ("policy:decision", r#"{"workerId":"w1","tool":"WebFetch","behavior":"ask"}"#.to_owned()),
            (
                "notification:fire",
                r#"{"title":"Approval needed","body":"w1 wants to run WebFetch: {\"url\":\"https://x\",\"n\":2}","workerId":"w1","ts":1000}"#
                    .to_owned()
            ),
            ("pending:created", r#"{"id":"p-00000001","workerId":"w1"}"#.to_owned()),
        ]
    );
    let row = f.temp.store.read_blocking(|tx| tx.pending().find("p-00000001")).expect("reads").expect("the row");
    assert_eq!(row.input, r#"{"url":"https://x","n":2}"#, "numbers as JavaScript prints them");
    assert_eq!(row.tool_use_id.as_deref(), Some("call_1"));
    let pending_events = f
        .temp
        .store
        .read_blocking(|tx| tx.events().list_by_type("w1", WorkerEventType::PermissionPending, None))
        .expect("reads");
    assert_eq!(pending_events[0].payload.as_deref(), Some(r#"{"id":"p-00000001","tool":"WebFetch"}"#));

    // Allowed as asked: the call runs with its own input.
    f.gateway.resolve("p-00000001", Answer::Allow { updated_input: None }).await.expect("resolves");
    let answered = waiting.await.expect("joins").expect("decides");
    assert_eq!(
        serde_json::to_value(&answered).expect("json"),
        json!({"behavior": "allow", "updatedInput": {"url": "https://x", "n": 2}})
    );
    assert_eq!(
        f.temp.announced.list().last().expect("an event"),
        &("pending:resolved", r#"{"id":"p-00000001","behavior":"allow"}"#.to_owned())
    );
    let row = f.temp.store.read_blocking(|tx| tx.pending().find("p-00000001")).expect("reads").expect("the row");
    assert_eq!(
        (row.resolved, row.decision.as_deref(), row.reason, row.updated_input.as_deref()),
        (true, Some("allow"), None, Some(r#"{"url":"https://x","n":2}"#))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resolving_answers_once_and_names_what_is_wrong() {
    let f = fixture("acceptEdits", ask_rule());
    assert_eq!(
        f.gateway.resolve("p-nope", Answer::Allow { updated_input: None }).await,
        Err(Error::not_found("pending", "p-nope"))
    );

    let gateway = f.gateway.clone();
    let waiting = tokio::spawn(async move { gateway.decide(call("Bash", json!({"command": "ls"}))).await });
    parked(&f, 1).await;
    let changed = record(json!({"command": "ls -la"}));
    f.gateway.resolve("p-00000001", Answer::Allow { updated_input: Some(changed) }).await.expect("resolves");
    let answered = waiting.await.expect("joins").expect("decides");
    assert_eq!(
        serde_json::to_value(&answered).expect("json"),
        json!({"behavior": "allow", "updatedInput": {"command": "ls -la"}})
    );

    assert_eq!(
        f.gateway.resolve("p-00000001", Answer::Deny { reason: None }).await,
        Err(Error::Conflict("already resolved: allow".into()))
    );

    // An ask nobody waits on (the app restarted) is still answerable; a deny
    // without a reason is "denied by human".
    f.temp.exec(
        "INSERT INTO pending_permissions (id, worker_id, tool_name, input, created_at, expires_at) \
         VALUES ('p-old', 'w1', 'Bash', '{\"command\":\"x\"}', 1, 2), ('p-bad', 'w1', 'Bash', 'not json', 1, 2)",
    );
    f.gateway.resolve("p-old", Answer::Deny { reason: None }).await.expect("resolves");
    let row = f.temp.store.read_blocking(|tx| tx.pending().find("p-old")).expect("reads").expect("the row");
    assert_eq!((row.decision.as_deref(), row.reason.as_deref()), (Some("deny"), Some("denied by human")));
    assert_eq!(
        f.gateway.resolve("p-bad", Answer::Allow { updated_input: None }).await,
        Err(Error::Validation("pending permission input is not valid JSON".into()))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worker_that_ends_releases_its_calls_and_stale_asks_are_swept() {
    let f = fixture("acceptEdits", ask_rule());
    f.temp.exec("INSERT INTO workers (id, state, prompt, started_at, permission_mode) VALUES ('w2', 'IDLE', '', 1, 'acceptEdits')");
    f.temp.exec(
        "INSERT INTO pending_permissions (id, worker_id, tool_name, input, created_at, expires_at) \
         VALUES ('p-stale', 'w9', 'Bash', '{}', 1, 500), ('p-fresh', 'w9', 'Bash', '{}', 1, 999999)",
    );
    let (one, two) = (f.gateway.clone(), f.gateway.clone());
    let first = tokio::spawn(async move { one.decide(call("Bash", json!({}))).await });
    let other = tokio::spawn(async move { two.decide(ToolCall::new("w2", "Bash", UnknownRecord::new())).await });
    parked(&f, 2).await;

    // Both asks are past their time by now, but their callers still wait.
    f.clock.set(100_000);
    assert_eq!(f.gateway.worker_gone("w1").await, Ok(2), "the stale ask and the ended worker's own");
    let answered = first.await.expect("joins").expect("decides");
    assert_eq!(message(&answered), "worker exited before permission was resolved");
    assert!(!other.is_finished(), "another worker's call keeps waiting");
    assert_eq!(f.gateway.waiting(), 1);

    let stale = f.temp.store.read_blocking(|tx| tx.pending().find("p-stale")).expect("reads").expect("the row");
    assert_eq!(
        (stale.resolved, stale.decision.as_deref(), stale.reason.as_deref()),
        (true, Some("deny"), Some("expired (swept on worker exit)"))
    );
    let open: Vec<String> = f
        .temp
        .store
        .read_blocking(|tx| tx.pending().list_unresolved())
        .expect("reads")
        .into_iter()
        .map(|p| p.worker_id)
        .collect();
    assert_eq!(open, ["w9", "w2"], "the ask in time, and the one whose caller still waits");

    other.abort();
    let _ = other.await;
    assert_eq!(f.gateway.waiting(), 0, "a caller that stops waiting leaves nothing behind");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_session_gate_keeps_views_and_control_tools_for_the_main_agent() {
    let f = fixture(
        "bypassPermissions",
        json!({"default": "allow", "rules": [{"tool": "mcp__orchestrator__spawn_worker", "action": "allow"}]}),
    );
    let gate: Arc<dyn PolicyDecider> = f.gateway.clone();
    let from_subagent = |tool: &str| {
        let mut c = call(tool, json!({}));
        c.agent_id = Some("a1".into());
        c
    };

    let view = gate.decide(from_subagent("mcp__worker__present")).await.expect("decides");
    assert_eq!(
        message(&view),
        "mcp__worker__present is main-agent only — return your findings; the main agent presents them."
    );
    assert!(f.temp.announced.list().is_empty(), "the lane's own rule leaves no trail");

    let spawn = gate.decide(from_subagent("mcp__orchestrator__spawn_worker")).await.expect("decides");
    assert!(message(&spawn).contains("main-agent only — subagents cannot use Eos control tools"));
    let user_tool = gate.decide(from_subagent("mcp__context7__query-docs")).await.expect("decides");
    assert_eq!(behavior(&user_tool), "allow");
    let main_agent = gate.decide(call("mcp__orchestrator__spawn_worker", json!({}))).await.expect("decides");
    assert_eq!(behavior(&main_agent), "allow");

    // A built-in with no surface in Eos is refused even with full access, except in a focused session.
    assert_eq!(behavior(&gate.decide(call("Workflow", json!({}))).await.expect("decides")), "deny");
    let mut focused = call("Workflow", json!({}));
    focused.full_surface = true;
    assert_eq!(behavior(&gate.decide(focused).await.expect("decides")), "allow");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_rule_applies_to_the_next_call() {
    let f = fixture("acceptEdits", ask_rule());
    assert_eq!(f.gateway.save_rule("WebFetch", PolicyBehavior::Allow), Ok(true));
    assert_eq!(f.gateway.save_rule("WebFetch", PolicyBehavior::Deny), Ok(false), "one rule per tool");
    assert_eq!(
        f.file.document(),
        Some(json!({"default": "ask", "ttlMs": 3000, "rules": [{"tool": "WebFetch", "action": "allow"}]}))
    );
    let decision = f.gateway.decide(call("WebFetch", json!({"url": "https://x"}))).await.expect("decides");
    assert_eq!(behavior(&decision), "allow");
}
