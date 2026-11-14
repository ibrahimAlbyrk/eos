//! The dev run's guard against the composed app: a route of the Rust core that is not a
//! plain read must have been classified, so a new one cannot start an agent, reach another
//! computer or change the user's folders from a copy of real data because nobody looked.

#![cfg(feature = "dev-run")]

use eos_bridge::dev::guard::{FOLDER_ROUTES, HARMLESS_ROUTES, REFUSED_ROUTES, allows};
use eos_testkit::TempHome;

/// Modules whose routes act on agents, terminals or other computers: their reads are
/// classified too.
const AGENT_MODULES: [&str; 6] = ["agents", "terminals", "btw", "compaction", "dreams", "auto-name"];

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
