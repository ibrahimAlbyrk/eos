//! An App's body: its manifest read, its code scanned for every way out of
//! the frame and every bridge name it does not declare, and its line of
//! access written from the manifest.

use eos_surface::{AppDesign, FileRoot};
use serde_json::{Value, json};

const UNDO: &str = r#"<!doctype html><button id="go">Run</button>
<script>
  const call = (name, args) => parent.postMessage({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}, "*");
  document.getElementById("go").onclick = () => call("routine.run_again", {});
  call("query.surface.issues", {});
  call("state.set", {count: 1});
  call("files.read", {path: "levels/one.json"});
</script>"#;

fn body(html: &str, manifest: Value) -> Value {
    json!({"html": html, "manifest": manifest, "tests": "eosTest.click('#go'); eosTest.expect(eosTest.calls().length > 0);"})
}

fn manifest() -> Value {
    json!({
        "title": "Level editor",
        "summary": "Edits the game's levels.",
        "height": 480,
        "uses": ["routine.run_again"],
        "queries": ["surface.issues"],
        "files": {"root": "project", "read": ["levels/*.json"], "write": ["levels/*.json"]},
    })
}

fn is_action(name: &str) -> bool {
    ["routine.run_again", "routine.open_run"].contains(&name)
}

fn problems(body: &Value) -> Vec<String> {
    match AppDesign::from_body(body, is_action) {
        Ok(_) => Vec::new(),
        Err(problems) => problems.iter().map(ToString::to_string).collect(),
    }
}

#[test]
fn an_app_that_calls_only_what_it_declares_reads_back_as_it_came() {
    let app = AppDesign::from_body(&body(UNDO, manifest()), is_action).expect("an App");
    assert_eq!(app.manifest.files.as_ref().map(|f| f.root), Some(FileRoot::Project));
    assert_eq!(AppDesign::from_body(&app.to_body(), is_action).expect("again"), app);
    let line = app.access_line(|id| id.replace('.', " "));
    assert_eq!(
        line,
        "This App can routine run_again; reads surface issues; can read levels/*.json in this project; \
         can write levels/*.json in this project."
    );
    let bare = json!({"title": "Clock", "summary": "Shows the time."});
    let clock = AppDesign::from_body(&body("<p>12:00</p>", bare), is_action).expect("an App");
    assert_eq!(clock.access_line(str::to_owned), "This App only draws itself: it reaches nothing of yours.");
}

#[test]
fn every_way_past_the_bridge_is_refused() {
    for code in [
        "<script>fetch ('https://x.example')</script>",
        "<script>new XMLHttpRequest()</script>",
        "<script>new WebSocket('wss://x')</script>",
        "<script>navigator.sendBeacon('/x')</script>",
        "<IFRAME src=x></IFRAME>",
        "<script>window.open('https://x')</script>",
        "<script>document.cookie = 'a'</script>",
        "<script>localStorage.setItem('a', 1)</script>",
        "<script>indexedDB.open('x')</script>",
        "<script>importScripts('x.js')</script>",
    ] {
        let found = problems(&body(code, manifest()));
        assert_eq!(found.len(), 1, "{code}: {found:?}");
        assert!(found[0].contains("only through its bridge"), "{code}");
    }
}

#[test]
fn a_bridge_name_the_manifest_does_not_declare_is_refused() {
    let mut narrow = manifest();
    narrow["uses"] = json!([]);
    narrow["queries"] = json!([]);
    narrow["files"] = json!({"root": "project", "read": ["levels/*.json"]});
    let found = problems(&body(&format!("{UNDO}<script>call('files.write', {{}})</script>"), narrow));
    assert_eq!(
        found,
        [
            "html: calls `routine.run_again`, which its manifest does not declare",
            "html: calls `query.surface.issues`, which its manifest does not declare",
            "html: calls `files.write`, which its manifest does not declare",
        ]
    );
}

#[test]
fn a_manifest_out_of_shape_says_each_problem() {
    let odd = json!({
        "title": "",
        "summary": "x",
        "height": 2000,
        "files": {"root": "home", "read": ["../secrets/*"], "write": ["/etc/hosts"]},
        "network": true,
    });
    let found = problems(&json!({"html": "<p>x</p>", "manifest": odd, "extra": 1}));
    assert_eq!(found.len(), 5, "{found:?}");
    let mut files = manifest();
    files["files"] = json!({"root": "project", "read": ["../x"], "write": ["/abs", ".git/hooks/*", "a/.claude/*"]});
    let found = problems(&body("<p>x</p>", files));
    assert_eq!(found.len(), 4, "{found:?}");
    let big = "x".repeat(eos_surface::APP_HTML_BYTES + 1);
    assert_eq!(problems(&body(&big, manifest())).len(), 1);
}
