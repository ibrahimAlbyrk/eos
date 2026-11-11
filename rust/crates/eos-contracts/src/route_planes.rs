//! Port of `contracts/src/route-planes.ts`: which routes may be driven from
//! another computer.
//!
//! One router serves two planes: the UI plane (everything the dashboard
//! calls) and a local plane only this Mac uses. A paired device gets the UI
//! plane; the local plane is never forwarded.

/// `(method, template)`. `*` matches every method; `:name` matches one path
/// segment; a trailing `/*` matches the prefix and anything below it.
pub type RouteRule = (&'static str, &'static str);

/// The kernel's own; a feature declares its local-only routes itself.
pub const KERNEL_LOCAL_ONLY_ROUTES: &[RouteRule] = &[
    ("POST", "/workers/:id/events"),
    ("POST", "/policy/decide"),
    ("POST", "/workers/:id/question"),
    ("GET", "/workers/:id/question/:qId"),
    ("POST", "/workers/:id/peer-request"),
    ("GET", "/workers/:id/peer-request/:rId"),
    ("POST", "/workers/:id/peer-response"),
    ("POST", "/workers/:id/report"),
    ("GET", "/pick-directory"),
    ("GET", "/pick-file"),
    ("*", "/api/peer/*"),
    ("*", "/api/hosts/*"),
    ("*", "/api/remote/*"),
    // Installing or removing plugins: code that runs in this Mac's window.
    ("*", "/api/plugins/install/*"),
    ("POST", "/api/plugins/:id/update"),
    ("DELETE", "/api/plugins/:id"),
    // Drawn by this Mac's app, for the agent writing the plugin.
    ("POST", "/api/plugins/:id/preview"),
    ("*", "/h/*"),
    ("*", "/peer/*"),
];

/// Public by design, on the host too; everything else that crosses must come
/// from the user's own dashboard.
pub const PEER_OPEN_ROUTES: &[RouteRule] = &[("GET", "/api/host"), ("GET", "/ui/*")];

/// Whether `path` (query ignored) matches a rule template.
pub fn template_matches(template: &str, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    let (base, prefix) = match template.strip_suffix("/*") {
        Some(base) => (base, true),
        None => (template, false),
    };
    let mut want = base.split('/');
    let mut got = path.split('/');
    loop {
        match (want.next(), got.next()) {
            (Some(w), Some(g)) => {
                let param = w.len() > 1 && w.starts_with(':');
                if !(w == g || (param && !g.is_empty())) {
                    return false;
                }
            }
            (None, None) => return true,
            (None, Some(_)) => return prefix,
            (Some(_), None) => return false,
        }
    }
}

/// `compileRouteRules(rules)(method, path)`.
pub fn matches_route_rules(rules: &[RouteRule], method: &str, path: &str) -> bool {
    rules.iter().any(|(m, template)| (*m == "*" || *m == method) && template_matches(template, path))
}

pub fn is_peer_open_route(method: &str, path: &str) -> bool {
    matches_route_rules(PEER_OPEN_ROUTES, method, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_only(method: &str, path: &str) -> bool {
        matches_route_rules(KERNEL_LOCAL_ONLY_ROUTES, method, path)
    }

    // contracts/src/__tests__/route-planes.test.ts
    #[test]
    fn the_kernels_local_only_routes() {
        for (m, p) in [
            ("POST", "/workers/w1/events"),
            ("POST", "/policy/decide"),
            ("GET", "/workers/w1/question/q9"),
            ("GET", "/pick-directory?start=/tmp"),
            ("GET", "/api/peer"),
            ("POST", "/api/peer/invite"),
            ("DELETE", "/api/peer/devices/ab"),
            ("GET", "/api/hosts"),
            ("POST", "/api/hosts/x/reconnect"),
            ("GET", "/h/abc/workers"),
            ("POST", "/peer/pair"),
            ("POST", "/peer/reverse"),
            ("PUT", "/api/remote/config"),
            ("POST", "/workers/w1/report"),
        ] {
            assert!(local_only(m, p), "{m} {p}");
        }
        for (m, p) in [
            ("GET", "/workers"),
            ("GET", "/stream?clientId=x"),
            ("POST", "/workers/w1/message"),
            ("GET", "/workers/w1/events"),
            ("POST", "/workers/w1/question-answer"),
            ("POST", "/pty/p1/input"),
            ("GET", "/api/host"),
            ("POST", "/workers/w1/keystroke"),
            ("GET", "/fs/raw/Users/me/a.png"),
            ("GET", "/workers/w1/report"),
        ] {
            assert!(!local_only(m, p), "{m} {p}");
        }
    }

    #[test]
    fn peer_open_is_only_the_hosts_public_face() {
        for p in ["/api/host", "/ui/index.html", "/ui/assets/app-1a2b.js?v=3"] {
            assert!(is_peer_open_route("GET", p), "{p}");
        }
        for (m, p) in [
            ("POST", "/fs/open"),
            ("POST", "/fs/paste"),
            ("GET", "/fs/raw/Users/me/.ssh/id_ed25519"),
            ("GET", "/fs/read?path=/etc/hosts"),
            ("GET", "/stream"),
            ("GET", "/workers"),
            ("POST", "/workers"),
            ("POST", "/api/host"),
            ("GET", "/uix"),
        ] {
            assert!(!is_peer_open_route(m, p), "{m} {p}");
        }
    }
}
