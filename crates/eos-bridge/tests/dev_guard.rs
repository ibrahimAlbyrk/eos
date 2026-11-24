//! The dev run's guard against the composed app: a route of the Rust core that is not a
//! plain read must have been classified, so a new one cannot start an agent, reach another
//! computer or change the user's folders from a copy of real data because nobody looked.

#![cfg(feature = "dev-run")]

use eos_bridge::dev::guard::{FOLDER_ROUTES, HARMLESS_ROUTES, REFUSED_ROUTES, allows};
use eos_testkit::TempHome;

/// Modules whose routes act on agents, terminals or other computers: their reads are
/// classified too.
const AGENT_MODULES: [&str; 7] = ["agents", "terminals", "btw", "compaction", "dreams", "auto-name", "routines"];

#[tokio::test(flavor = "multi_thread")]
async fn every_route_that_is_not_a_plain_read_is_classified() {
    let home = TempHome::new();
    let app = eos_app::App::build(eos_app::Options::new(home.path())).expect("the app builds");
    let listed = |method: &str, pattern: &str| {
        REFUSED_ROUTES.iter().chain(FOLDER_ROUTES).chain(HARMLESS_ROUTES).any(|(m, p)| *m == method && *p == pattern)
    };
    let mut unclassified = Vec::new();
    let mut writes = 0;
    for route in app.router().routes() {
        let method = route.methods.to_string();
        let read = matches!(method.as_str(), "GET" | "HEAD");
        writes += usize::from(!read);
        let must_be_listed = !read || AGENT_MODULES.contains(&route.owner.as_ref());
        if must_be_listed && !listed(&method, &route.pattern) {
            unclassified.push(format!("{method} {} (module {})", route.pattern, route.owner));
        }
    }
    assert!(writes > 80, "the app's routes were read: {writes} writes");
    assert_eq!(
        unclassified,
        Vec::<String>::new(),
        "decide for each: REFUSED_ROUTES, FOLDER_ROUTES or HARMLESS_ROUTES, in eos-bridge/src/dev/guard.rs"
    );
    // What the app declares today that can make an agent run is refused.
    for (method, pattern) in [("POST", "/workers"), ("POST", "/workers/{id}/message"), ("POST", "/workers/{id}/resume")]
    {
        assert!(
            app.router().routes().any(|r| r.methods.to_string() == method && r.pattern.as_ref() == pattern),
            "{pattern}"
        );
        assert!(!allows(method, pattern, b"{}", Some(home.path())));
    }
}

/// The terminal's gateway reaches the core the way the dashboard does, behind the guard. It
/// starts no run itself: a run is asked in the app's window, and with no window to ask (no
/// shell answers here) nothing starts and the command ends with 3.
#[tokio::test(flavor = "multi_thread")]
async fn the_terminal_cannot_start_a_run_in_a_dev_run() {
    use std::sync::Arc;

    use eos_bridge::cli::{CliGateway, CliParts};
    use eos_bridge::dev::Guarded;
    use eos_bridge::{Classify, RouterCore};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let home = TempHome::new();
    let app = eos_app::App::build(eos_app::Options::new(home.path())).expect("the app builds");
    app.start().await.expect("the app starts");
    let rt = tokio::runtime::Handle::current();
    let callers = app.callers().clone();
    let ui_token = callers.ui_token().to_owned();
    let classify: Classify = Arc::new(move |token, target| callers.classify_for(token, target));
    let guarded = Guarded::new(Arc::new(RouterCore::new(app.router(), ui_token, classify, rt.clone())));
    let shell = home.path().join("shell");
    let parts = CliParts { core: Arc::new(guarded), data_dir: shell.clone(), scheme: "eos-dev", version: "0".into() };
    let _gateway = CliGateway::start(parts, &rt).expect("listens");

    let stream = tokio::net::UnixStream::connect(shell.join("cli.sock")).await.expect("connects");
    let (read, mut write) = stream.into_split();
    write.write_all(b"{\"cmd\":\"once\",\"what\":\"Tidy my downloads\"}\n").await.expect("sent");
    let mut lines = BufReader::new(read).lines();
    let mut got = Vec::new();
    while let Some(line) = lines.next_line().await.expect("a line") {
        let done = line.contains("\"done\"");
        got.push(line);
        if done {
            break;
        }
    }
    assert_eq!(got.len(), 2, "{got:?}");
    assert!(got[0].contains("Eos did not answer"), "{got:?}");
    assert_eq!(got[1], r#"{"t":"done","exit":3}"#);
    let runs = app.store().read(|tx| tx.runs().active()).await.expect("reads");
    assert_eq!(runs.0, 0, "nothing was started");
    app.shutdown(std::time::Duration::from_secs(5)).await;
}
