//! The route table as data: every route the 0.1.x app declared
//! with the methods its path answers, and the routes only the Rust core has
//! ([`Route::added`]).
//!
//! `cargo xtask contracts` exports it as JSON and writes the dashboard's
//! `app/ui/src/api/routes.js` from it.

use std::fmt;

use serde::Serialize;

mod table;

pub use table::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
    Head,
}

impl Method {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
        }
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One entry of the route table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Route {
    /// The key in `ROUTES` (`workerEvents`).
    pub name: &'static str,
    /// The path, with `:name` for each parameter (`/workers/:id/events`).
    pub path: &'static str,
    pub methods: &'static [Method],
    /// Parameters the dashboard percent-encodes when it builds the path.
    pub encoded: &'static [&'static str],
    /// The key names a prefix: requests go to paths below it (`/fs/raw/…`).
    pub prefix: bool,
    /// A route of the Rust core that today's daemon does not have: additive,
    /// so a client that does not know it keeps working.
    pub added: bool,
}

impl Route {
    pub const fn new(name: &'static str, path: &'static str, methods: &'static [Method]) -> Self {
        Self { name, path, methods, encoded: &[], prefix: false, added: false }
    }

    pub const fn added(mut self) -> Self {
        self.added = true;
        self
    }

    pub const fn encoding(mut self, params: &'static [&'static str]) -> Self {
        self.encoded = params;
        self
    }

    pub const fn as_prefix(mut self) -> Self {
        self.prefix = true;
        self
    }

    /// Parameter names, in path order.
    pub fn params(&self) -> impl Iterator<Item = &'static str> {
        self.path.split('/').filter_map(|seg| seg.strip_prefix(':'))
    }

    /// The path with its parameters filled in order, as the dashboard's
    /// `ROUTES.<name>(…)` builds it. Missing arguments leave the path short.
    pub fn path_with(&self, args: &[&str]) -> String {
        let mut args = args.iter();
        let mut out = String::with_capacity(self.path.len() + 16);
        for seg in self.path.split('/').skip(1) {
            out.push('/');
            match seg.strip_prefix(':') {
                Some(name) => {
                    let value = args.next().copied().unwrap_or_default();
                    if self.encoded.contains(&name) {
                        encode_uri_component(value, &mut out)
                    } else {
                        out.push_str(value)
                    }
                }
                None => out.push_str(seg),
            }
        }
        out
    }
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(value: &str, out: &mut String) {
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
}

/// The route with this `ROUTES` key.
pub fn route(name: &str) -> Option<&'static Route> {
    ROUTES.iter().find(|r| r.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_built_like_the_dashboard_builds_them() {
        // app/ui/src/api/routes.test.js
        assert_eq!(WORKERS_ARCHIVED.path_with(&[]), "/workers/archived");
        assert_eq!(WORKER_ARCHIVE.path_with(&["w1"]), "/workers/w1/archive");
        assert_eq!(GENUI_VIEW_STATE.path_with(&["v_abcdefghijkl"]), "/api/genui/views/v_abcdefghijkl/state");
        assert_eq!(WORKER_WORKFLOW_AGENT.path_with(&["w", "c", "a"]), "/workers/w/workflow-runs/c/agents/a");
        // Only the parameters the dashboard encodes are encoded.
        assert_eq!(PLUGIN_STORE.path_with(&["acme.notes", "a b/ç"]), "/api/plugins/acme.notes/store/a%20b%2F%C3%A7");
        assert_eq!(WORKER.path_with(&["a b"]), "/workers/a b");
    }

    #[test]
    fn the_table_is_well_formed() {
        let mut names: Vec<_> = ROUTES.iter().map(|r| r.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), ROUTES.len(), "duplicate route name");
        for r in ROUTES {
            assert!(r.path.starts_with('/'), "{}", r.name);
            assert!(!r.methods.is_empty(), "{}", r.name);
            let params: Vec<_> = r.params().collect();
            assert!(r.encoded.iter().all(|e| params.contains(e)), "{}", r.name);
        }
        assert_eq!(route("workerEvents").map(|r| r.path), Some("/workers/:id/events"));
        assert_eq!(WORKER_EVENTS.methods, [Method::Get, Method::Post]);
    }
}
