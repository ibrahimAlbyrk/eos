//! The write guard of the dev proxy.
//!
//! The daemon behind the proxy runs on a copy of real user data. A stray request could start
//! an agent there (it happened once: a keystroke meant for another field sent a chat
//! message). So the proxy forwards reads, and of the writes only the ones listed here; there
//! is no switch to turn this off.

/// Writes the dashboard needs to draw itself: the browser panel's own routes, the watches
/// of the explorer and the git status, and which chat the event stream follows. None of
/// them can start an agent or a model call.
const ALLOWED_WRITES: [&str; 6] =
    ["/browser/", "/fs/git/unwatch", "/fs/git/watch", "/fs/unwatch", "/fs/watch", "/stream/focus"];

fn path_of(target: &str) -> &str {
    target.split_once('?').map_or(target, |(path, _)| path)
}

/// Whether the proxy forwards this request.
pub fn allows(method: &str, target: &str) -> bool {
    if matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return true;
    }
    let path = path_of(target);
    // A dot segment could make an allowed prefix resolve to another route.
    if path.split('/').any(|segment| segment == ".." || segment == "." || segment.eq_ignore_ascii_case("%2e%2e")) {
        return false;
    }
    ALLOWED_WRITES
        .iter()
        .any(|allowed| if allowed.ends_with('/') { path.starts_with(allowed) } else { path == *allowed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pass() {
        for target in ["/health", "/workers", "/workers/w1/events?since=3", "/stream?topics=x", "/api/settings"] {
            assert!(allows("GET", target), "{target}");
        }
        assert!(allows("HEAD", "/fs/raw?path=/a"));
    }

    #[test]
    fn every_write_to_an_agent_route_is_refused() {
        for (method, target) in [
            ("POST", "/workers/w1/message"),
            ("POST", "/workers"),
            ("POST", "/orchestrators"),
            ("POST", "/workers/w1/btw"),
            ("POST", "/workers/w1/resume"),
            ("DELETE", "/workers/w1"),
            ("PUT", "/api/settings"),
            ("PATCH", "/api/profile"),
            ("POST", "/pty"),
            ("POST", "/policy/decide"),
            ("POST", "/fs/open"),
            ("POST", "/fs/watcher"),
            ("POST", "/fs/git/commit"),
            ("POST", "/fs/git/watch/x"),
            ("POST", "/stream/focus/x"),
            ("POST", "/browserx/tabs"),
            ("POST", "/"),
        ] {
            assert!(!allows(method, target), "{method} {target}");
        }
    }

    #[test]
    fn the_dashboards_own_writes_pass() {
        assert!(allows("POST", "/browser/tabs?session=s"));
        assert!(allows("POST", "/browser/tabs/t1/navigate"));
        assert!(allows("DELETE", "/browser/tabs/t1"));
        assert!(allows("POST", "/fs/watch"));
        assert!(allows("POST", "/fs/unwatch?x=1"));
        assert!(allows("POST", "/fs/git/watch"));
        assert!(allows("POST", "/fs/git/unwatch"));
        assert!(allows("POST", "/stream/focus"));
    }

    #[test]
    fn an_allowed_prefix_cannot_be_used_to_reach_another_route() {
        assert!(!allows("POST", "/browser/../workers/w1/message"));
        assert!(!allows("POST", "/browser/%2e%2e/workers/w1/message"));
        assert!(!allows("POST", "/browser/./../workers"));
        assert!(!allows("POST", "/fs/watch/../../workers"));
    }
}
