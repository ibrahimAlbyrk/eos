//! What a dev run lets the Rust core answer.
//!
//! The core opens a copy of real data and runs agents itself. A stray request could start
//! one there (it happened once: a keystroke meant for another field sent a chat message).
//! So a dev run refuses whatever starts an agent, a model call or a command, connects to
//! another computer or the relay, or changes files outside the copied data folder, unless
//! the run was started with `EOS_DEV_ALLOW_AGENTS=1`. A route that is not a plain read must
//! be on one of the three lists below; one that is on none is refused, and a test over the
//! composed app fails until someone has decided where it belongs.

/// What a dev run answers a refused request with.
pub const REFUSAL: &str = r#"{"error":"refused in a dev run: this request can start an agent, a model call or a command, reach another computer, or change files outside the data folder (EOS_DEV_ALLOW_AGENTS=1 allows it)"}"#;

/// Routes of the Rust core a dev run never lets through: `(method, route pattern)`, the
/// pattern as its module wrote it.
pub const REFUSED_ROUTES: &[(&str, &str)] = &[
    // Start, resume or message an agent.
    ("POST", "/orchestrators"),
    ("POST", "/orchestrators/{id}/message"),
    ("POST", "/workers"),
    ("POST", "/workers/{id}/message"),
    ("POST", "/workers/{id}/resume"),
    ("POST", "/workers/{id}/rewind"),
    // Reach another agent: a report to the parent, a question to a peer and its answer, a
    // key sent to a session.
    ("POST", "/workers/{id}/report"),
    ("POST", "/workers/{fromWorker}/peer-request"),
    ("POST", "/workers/{id}/peer-response"),
    ("POST", "/workers/{id}/keystroke"),
    // Continues a stopped session on an API key; schedules a resume for later.
    ("POST", "/workers/{id}/api-key-continue"),
    ("PUT", "/workers/{id}/plan-resume"),
    // Restart a live session with other settings.
    ("PUT", "/workers/{id}/model"),
    ("PUT", "/workers/{id}/permission"),
    ("PUT", "/workers/{id}/backend"),
    // End a chat or bring one back: its recorded conversation in Claude Code's folder and
    // its worktree in the user's repository go or come with it.
    ("DELETE", "/workers/{id}"),
    ("DELETE", "/workers/{id}/purge"),
    ("POST", "/workers/{id}/archive"),
    ("POST", "/workers/{id}/restore"),
    ("POST", "/workers/archived/app-closed"),
    // Model calls without a chat turn: a side question, a name for the chat, a dream.
    ("POST", "/workers/{id}/btw"),
    ("PUT", "/workers/{id}/rename-intent"),
    ("POST", "/api/dreams"),
    // Terminals: a shell or a Claude pane, keys typed into one, a `!` command.
    ("POST", "/pty"),
    ("POST", "/pty/{id}/input"),
    ("POST", "/pty/{id}/message"),
    ("POST", "/pty/{id}/answer"),
    ("POST", "/workers/{id}/terminal"),
    ("POST", "/terminal"),
    // Transfers: files to or from another computer, written into the user's own folders.
    ("PUT", "/transfer/write"),
    ("POST", "/transfer/prepare"),
    ("POST", "/transfer/commit"),
    ("POST", "/api/transfers"),
    ("POST", "/api/transfers/destination"),
    ("POST", "/api/transfers/:id/resume"),
    ("POST", "/api/transfers/:id/decide"),
    ("POST", "/workers/:id/transfers"),
    // The phone link: arming it and pairing a phone dial the relay; its configuration is
    // the switch that turns that on.
    ("POST", "/api/remote/arm"),
    ("POST", "/api/remote/pair"),
    ("PUT", "/api/remote/config"),
    // Other computers: hosting this one, pairing with one, dialling one, and everything
    // sent to one through the facade, reads included.
    ("PUT", "/api/peer"),
    ("POST", "/api/peer/invite"),
    ("POST", "/api/hosts"),
    ("PUT", "/api/hosts/{id}"),
    ("POST", "/api/hosts/{id}/reconnect"),
    ("GET", "/h/{id}"),
    ("GET", "/h/{id}/"),
    ("GET", "/h/{id}/{*rest}"),
    ("POST", "/h/{id}"),
    ("POST", "/h/{id}/"),
    ("POST", "/h/{id}/{*rest}"),
    ("PUT", "/h/{id}"),
    ("PUT", "/h/{id}/"),
    ("PUT", "/h/{id}/{*rest}"),
    ("DELETE", "/h/{id}"),
    ("DELETE", "/h/{id}/"),
    ("DELETE", "/h/{id}/{*rest}"),
    // Reads every Claude sign-in's artifacts from Anthropic with its token, renewing a
    // refused one: a refresh token is single-use, so renewing a copied sign-in would sign
    // the real app out of it.
    ("POST", "/api/artifacts/refresh"),
    // Fetches the model list from Anthropic with the token of a sign-in, renewed the same way.
    ("POST", "/api/model-catalog/refresh"),
    // Sync: talks to the relay's vault.
    ("POST", "/api/sync/create"),
    ("POST", "/api/sync/join"),
    ("POST", "/api/sync/now"),
    // A worker's folder: what writes into the user's checkout (Try, discarding a change,
    // a resolved conflict, merging workers' work), talks to its remote (push, pull) or opens
    // it in an app.
    ("POST", "/workers/{id}/try"),
    ("POST", "/workers/{id}/try/discard"),
    ("POST", "/workers/{id}/changes/discard"),
    ("POST", "/workers/{id}/conflicts/resolve"),
    ("POST", "/orchestrators/{id}/integrate"),
    ("POST", "/workers/{id}/push"),
    ("POST", "/workers/{id}/pull"),
    ("POST", "/workers/{id}/open"),
    // Forgetting a project memory removes a file of Claude Code's, outside the data folder.
    ("DELETE", "/workers/{id}/memory/{name}"),
    // Not in the Rust core yet; refused from the day they land.
    ("POST", "/workers/{id}/warm"),
    ("POST", "/workers/{id}/action"),
];

/// Routes that act on folders the request names: the Files and Changes panels, which work
/// on the user's real project folders. A dev run lets one through only when every path its
/// body names lies inside the copied data folder.
pub const FOLDER_ROUTES: &[(&str, &str)] = &[
    ("POST", "/fs/branch/create"),
    ("POST", "/fs/branch/delete"),
    ("POST", "/fs/branch/rename"),
    ("POST", "/fs/checkout"),
    ("POST", "/fs/create"),
    ("POST", "/fs/fetch"),
    ("POST", "/fs/move"),
    ("POST", "/fs/open"),
    ("POST", "/fs/open-in"),
    ("POST", "/fs/remote-branch/delete"),
    ("POST", "/fs/rename"),
    ("POST", "/fs/reveal"),
    ("POST", "/fs/stash/apply"),
    ("POST", "/fs/stash/drop"),
    ("POST", "/fs/trash"),
    ("POST", "/fs/write"),
];

/// Writes of the Rust core that start nothing, reach no other computer and stay inside the
/// data folder (or the temporary folder). A new write route is added here only after
/// someone has read what it does.
pub const HARMLESS_ROUTES: &[(&str, &str)] = &[
    // Stops a turn; drops a queued message; renames a chat; stops a workflow run.
    ("POST", "/workers/{id}/interrupt"),
    ("DELETE", "/workers/{id}/queue/{queueId}"),
    ("PUT", "/workers/{id}/name"),
    ("POST", "/workers/{id}/workflow-runs/{callId}/stop"),
    // The read-only routes of the agents and terminals modules.
    ("GET", "/workers/{id}/rewind-targets"),
    ("GET", "/workers/{id}/peers"),
    ("GET", "/workers/{fromWorker}/peer-request/{requestId}"),
    // What git says of a worker's folder. A Try preview and its state write only
    // unreferenced objects into the repository (and a temporary index).
    ("GET", "/workers/{id}/diff"),
    ("GET", "/workers/{id}/changes"),
    ("GET", "/workers/{id}/changes/file"),
    ("GET", "/workers/{id}/push-state"),
    ("GET", "/workers/{id}/conflicts"),
    ("GET", "/workers/{id}/conflicts/file"),
    ("GET", "/workers/{id}/try/preview"),
    ("GET", "/workers/{id}/try/state"),
    // A banner for the user.
    ("POST", "/workers/{id}/notify"),
    // Keeping a Try changes no file of the checkout, only its record in the data folder.
    ("POST", "/workers/{id}/try/keep"),
    ("GET", "/pty"),
    ("GET", "/pty/{id}/buffer"),
    ("GET", "/pty/{id}/conversation"),
    // Terminals that exist: a new size, the end of one, the end of a `!` command.
    ("POST", "/pty/{id}/resize"),
    ("DELETE", "/pty/{id}"),
    ("POST", "/terminal/{runId}/kill"),
    // Permission answers and questions: only a running agent asks or waits.
    ("POST", "/policy/decide"),
    ("POST", "/pending/{id}/decision"),
    ("POST", "/api/policy/rule"),
    ("POST", "/workers/{id}/question"),
    ("POST", "/workers/{id}/question-answer"),
    // Background jobs: stop, dismiss, clear.
    ("POST", "/api/jobs/{id}/stop"),
    ("POST", "/api/jobs/{id}/dismiss"),
    ("POST", "/api/jobs/clear"),
    // Dreams: reading past ones, stopping one, which chats they leave out.
    ("GET", "/api/dreams"),
    ("GET", "/api/dreams/status"),
    ("GET", "/api/dreams/{id}"),
    ("POST", "/api/dreams/stop"),
    ("POST", "/api/dreams/exclusions"),
    // Accounts: signing in and out of the isolated stores, which sign-in is used.
    ("POST", "/api/accounts/{provider}/sign-in"),
    ("DELETE", "/api/accounts/{provider}/sign-in"),
    ("DELETE", "/api/accounts/{provider}/logins/{id}"),
    ("PUT", "/api/accounts/{provider}/logins/{id}"),
    ("PUT", "/api/accounts/{provider}/auto-switch"),
    ("PUT", "/api/accounts/{provider}/default-login"),
    ("PUT", "/api/anthropic/config"),
    ("POST", "/api/sign-ins/{id}/code"),
    ("DELETE", "/api/sign-ins/{id}"),
    // Pages, profile, memories, templates, worker definitions, projects: the user's notes
    // and settings in the data copy.
    ("POST", "/api/pages"),
    ("PUT", "/api/pages/{id}"),
    ("DELETE", "/api/pages/{id}"),
    ("POST", "/api/pages/{id}/edit"),
    ("PUT", "/api/profile"),
    ("PUT", "/api/profile/avatar"),
    ("DELETE", "/api/profile/avatar"),
    ("POST", "/api/user-memories"),
    ("POST", "/api/user-memories/approve-all"),
    ("POST", "/api/user-memories/suggest"),
    ("POST", "/api/user-memories/{id}/approve"),
    ("POST", "/api/user-memories/{id}/dismiss"),
    ("PUT", "/api/user-memories/{id}"),
    ("DELETE", "/api/user-memories/{id}"),
    ("POST", "/api/templates"),
    ("PUT", "/api/templates/{name}"),
    ("DELETE", "/api/templates/{name}"),
    ("POST", "/worker-definitions"),
    ("PUT", "/projects"),
    ("POST", "/projects/delete"),
    ("POST", "/fs/recents/remove"),
    // The user's settings and the archive and compaction sections of `config.json`, in the
    // data copy.
    ("PUT", "/api/settings"),
    ("PUT", "/api/settings/archive"),
    ("PUT", "/api/settings/compaction"),
    // Renders a prompt; no model is asked.
    ("POST", "/api/prompts/preview"),
    // Visual answers: a view or an app an agent presents, its state, a place lookup on the
    // public map service (as the media reads already do), the feature's settings.
    ("POST", "/api/genui/views"),
    ("POST", "/api/genui/apps"),
    ("PUT", "/api/genui/views/{id}/state"),
    ("POST", "/api/genui/places"),
    ("PUT", "/api/settings/genui"),
    // Plugins: installing, switching, their stored values, a drawn preview.
    ("POST", "/api/plugins/install"),
    ("POST", "/api/plugins/install/{stagingId}"),
    ("DELETE", "/api/plugins/install/{stagingId}"),
    ("DELETE", "/api/plugins/{id}"),
    ("POST", "/api/plugins/{id}/preview"),
    ("POST", "/api/plugins/{id}/report"),
    ("POST", "/api/plugins/{id}/update"),
    ("PUT", "/api/plugins/{id}/enabled"),
    ("PUT", "/api/plugins/{id}/settings"),
    ("PUT", "/api/plugins/{id}/store/{key}"),
    // Updates: a dev build never updates itself.
    ("POST", "/api/update/check"),
    ("POST", "/api/update/dismiss"),
    ("POST", "/api/update/download"),
    ("POST", "/api/update/later"),
    ("POST", "/api/update/restart"),
    ("PUT", "/api/settings/updates"),
    // Other computers: taking an invite back, forgetting or cutting off a device or a
    // host, a token for a host's view (made here, sent nowhere).
    ("DELETE", "/api/peer/invite"),
    ("DELETE", "/api/peer/devices/{fp}"),
    ("POST", "/api/peer/devices/{fp}/disconnect"),
    ("DELETE", "/api/hosts/{id}"),
    ("POST", "/api/hosts/{id}/view-token"),
    // Transfers and sync: what only reads this computer or ends something.
    ("POST", "/transfer/scan"),
    ("POST", "/transfer/key"),
    ("POST", "/transfer/locate"),
    ("POST", "/transfer/abort"),
    ("DELETE", "/api/transfers"),
    ("POST", "/api/transfers/:id/pause"),
    ("POST", "/api/transfers/:id/cancel"),
    ("POST", "/api/sync/leave"),
    // The browser panel.
    ("POST", "/browser/launch"),
    ("POST", "/browser/show"),
    ("POST", "/browser/tabs"),
    ("DELETE", "/browser/tabs/{tabId}"),
    ("POST", "/browser/tabs/{tabId}/act"),
    ("POST", "/browser/tabs/{tabId}/capture"),
    ("POST", "/browser/tabs/{tabId}/device"),
    ("POST", "/browser/tabs/{tabId}/elements"),
    ("POST", "/browser/tabs/{tabId}/find"),
    ("POST", "/browser/tabs/{tabId}/get"),
    ("POST", "/browser/tabs/{tabId}/mute"),
    ("POST", "/browser/tabs/{tabId}/navigate"),
    ("POST", "/browser/tabs/{tabId}/snapshot"),
    ("POST", "/browser/tabs/{tabId}/wait"),
    // Several paths' stat at once: a read, sent as a POST for its list.
    ("POST", "/fs/stat"),
    // Watching a folder or a repository changes nothing in it; a paste lands in the
    // temporary folder.
    ("POST", "/fs/git/unwatch"),
    ("POST", "/fs/git/watch"),
    ("POST", "/fs/unwatch"),
    ("POST", "/fs/watch"),
    ("POST", "/fs/paste"),
    ("POST", "/fs/paste-b64"),
    // Which chat the event stream follows.
    ("POST", "/stream/focus"),
];

fn listed(list: &[(&str, &str)], method: &str, pattern: &str) -> bool {
    list.iter().any(|(m, p)| *m == method && *p == pattern)
}

/// Whether `path` lies inside `folder`, read as written: a `..` anywhere says no.
fn inside(path: &str, folder: &std::path::Path) -> bool {
    let path = std::path::Path::new(path);
    !path.components().any(|part| matches!(part, std::path::Component::ParentDir)) && path.starts_with(folder)
}

/// The paths a JSON body names: every string that reads as an absolute or a home path.
fn named_paths<'a>(value: &'a serde_json::Value, out: &mut Vec<&'a str>) {
    match value {
        serde_json::Value::String(text) if text.starts_with('/') || text.starts_with('~') => out.push(text),
        serde_json::Value::Array(items) => items.iter().for_each(|item| named_paths(item, out)),
        serde_json::Value::Object(map) => map.values().for_each(|item| named_paths(item, out)),
        _ => {}
    }
}

/// Whether a request for a [`FOLDER_ROUTES`] route stays inside the copied data folder: its
/// body names at least one path, and every path it names is in there.
fn stays_in(body: &[u8], data_folder: Option<&std::path::Path>) -> bool {
    let (Some(folder), Ok(body)) = (data_folder, serde_json::from_slice::<serde_json::Value>(body)) else {
        return false;
    };
    let mut paths = Vec::new();
    named_paths(&body, &mut paths);
    !paths.is_empty() && paths.iter().all(|path| inside(path, folder))
}

/// Whether a dev run lets the router answer a request for its route `pattern`
/// (`/workers/{id}/message`). A read passes unless it is listed as refused; a write passes
/// when it is listed as harmless, or acts only on folders inside `data_folder`.
pub fn allows(method: &str, pattern: &str, body: &[u8], data_folder: Option<&std::path::Path>) -> bool {
    if listed(REFUSED_ROUTES, method, pattern) {
        return false;
    }
    if listed(FOLDER_ROUTES, method, pattern) {
        return stays_in(body, data_folder);
    }
    matches!(method, "GET" | "HEAD" | "OPTIONS") || listed(HARMLESS_ROUTES, method, pattern)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rust_core_gets_no_request_that_could_make_an_agent_run() {
        for (method, pattern) in [
            ("POST", "/workers"),
            ("POST", "/orchestrators"),
            ("POST", "/workers/{id}/message"),
            ("POST", "/workers/{id}/resume"),
            ("POST", "/workers/{id}/rewind"),
            ("POST", "/workers/{id}/btw"),
            ("POST", "/pty"),
            ("POST", "/workers/{id}/terminal"),
            ("POST", "/api/dreams"),
            ("POST", "/api/sync/now"),
            ("POST", "/api/transfers"),
        ] {
            assert!(!allows(method, pattern, b"{}", None), "{method} {pattern}");
        }
        // Reads pass, and the writes someone has looked at.
        assert!(allows("GET", "/workers/{id}/events", b"", None));
        assert!(allows("POST", "/browser/tabs/{tabId}/navigate", b"{}", None));
        assert!(allows("PUT", "/api/pages/{id}", b"{}", None));
        // A write nobody has classified is refused.
        assert!(!allows("POST", "/workers/{id}/something-new", b"{}", None));
        assert!(!allows("PATCH", "/api/pages/{id}", b"{}", None));
    }

    #[test]
    fn the_files_panel_may_only_change_what_is_inside_the_data_folder() {
        let data = std::path::Path::new("/data/run-copy");
        let ask = |pattern: &str, body: &str| allows("POST", pattern, body.as_bytes(), Some(data));
        assert!(ask("/fs/write", r#"{"path":"/data/run-copy/pages/a.md","content":"x"}"#));
        assert!(ask("/fs/create", r#"{"root":"/data/run-copy/templates","path":"b.txt","type":"file"}"#));
        assert!(ask("/fs/trash", r#"{"root":"/data/run-copy","paths":["/data/run-copy/a","/data/run-copy/b"]}"#));
        // The user's real project folders, however the request names them.
        assert!(!ask("/fs/write", r#"{"path":"/Users/someone/project/a.txt","content":"x"}"#));
        assert!(!ask("/fs/trash", r#"{"root":"/data/run-copy","paths":["/data/run-copy/a","/Users/someone/b"]}"#));
        assert!(!ask("/fs/checkout", r#"{"cwd":"/Users/someone/project","branch":"main"}"#));
        assert!(!ask("/fs/move", r#"{"from":"/data/run-copy/a","to":"/data/run-copy/../elsewhere"}"#));
        assert!(!ask("/fs/write", r#"{"path":"~/notes.txt","content":"x"}"#));
        assert!(!ask("/fs/write", r#"{"path":"/data/run-copy-other/a.txt"}"#), "a folder that only starts alike");
        // A body that names no path, or is not JSON, or a run that does not know its folder.
        assert!(!ask("/fs/create", r#"{"path":"b.txt"}"#));
        assert!(!ask("/fs/write", "not json"));
        assert!(!allows("POST", "/fs/write", br#"{"path":"/data/run-copy/a"}"#, None));
        // Watching and pasting change nothing in a folder of the user's.
        assert!(ask("/fs/watch", r#"{"dir":"/Users/someone/project"}"#));
        assert!(ask("/fs/paste-b64", r#"{"name":"a.jpg","base64":"/9j/4AAQ"}"#));
    }

    #[test]
    fn no_route_is_on_two_lists() {
        for (method, pattern) in REFUSED_ROUTES.iter().chain(FOLDER_ROUTES) {
            assert!(!listed(HARMLESS_ROUTES, method, pattern), "{method} {pattern}");
        }
        for (method, pattern) in REFUSED_ROUTES {
            assert!(!listed(FOLDER_ROUTES, method, pattern), "{method} {pattern}");
        }
        assert!(REFUSAL.contains("refused in a dev run"));
    }
}
