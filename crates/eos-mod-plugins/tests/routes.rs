//! The plugin routes over the real adapters: a plugin built by esbuild and
//! served by revision, rebuilt when its folder changes, previews, and an
//! install from a registry served by the test — none of whose files may run.
//!
//! Tests that build a UI need the esbuild binary (`EOS_ESBUILD`, or the one
//! `host/scripts/setup.sh` fetches); without one they say so and pass.

mod support;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use eos_contracts::{PluginPreviewAvailable, PluginPreviewResult, PluginPreviewSurface};
use eos_core::BoxFuture;
use eos_plugin_files::{HttpFailure, RegistryHttp};
use eos_runtime::access::Caller;
use eos_runtime::bus::EventReceiver;
use eos_runtime::http::Method::{Delete, Get, Post, Put};
use eos_testkit::TempHome;
use eos_testkit::plugins::{FakePluginBuilder, FakePluginPreviewer};
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use support::{Parts, World, exists, tgz};

const UI: &str = "import { useState } from \"react\";\nimport \"./style.css\";\n\nexport default function activate(eos) {\n  eos.headerRight.add({ id: \"clock\", render: () => <b>{useState(0)[0]}</b> });\n}\n";

fn clock_home() -> TempHome {
    let home = TempHome::new();
    home.write("plugins/clock/plugin.json", r#"{"id":"clock","name":"Clock"}"#);
    home.write("plugins/clock/ui.jsx", UI);
    home.write("plugins/clock/style.css", ".clock { color: red; }\n");
    home
}

fn have_esbuild() -> bool {
    let found = support::esbuild().is_some();
    if !found {
        eprintln!("skipped: no esbuild binary (set EOS_ESBUILD or run host/scripts/setup.sh)");
    }
    found
}

/// Waits for `plugins:change` about `id`, then for the rebuild to be over.
async fn changed(world: &World, events: &mut EventReceiver, id: &str) {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(20), events.recv()).await.expect("a change in time");
        let event = event.expect("an event");
        if event.payload_as::<Value>().expect("JSON")["id"] == id && !world.host.plugins.is_busy(id) {
            return;
        }
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_built_plugin_is_served_by_revision_and_rebuilt_when_its_folder_changes() {
    if !have_esbuild() {
        return;
    }
    let world = World::on(clock_home(), Parts::default()).await;
    let mut events = world.runtime.kernel.bus.subscribe("plugins:change", 64);

    let (status, one) = world.call(Get, "/api/plugins/clock", None, false).await;
    assert_eq!(status, 200);
    let plugin = &one["plugin"];
    assert_eq!((&plugin["state"], &plugin["hasUi"], &plugin["hasCss"]), (&json!("active"), &json!(true), &json!(true)));
    let rev = plugin["rev"].as_i64().expect("a revision");
    assert!(rev >= 1);

    let (status, headers, js) = world.raw(Get, &format!("/ui/plugins/clock/{rev}.js"), None, false).await;
    assert_eq!(status, 200);
    assert_eq!(header(&headers, "content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(header(&headers, "cache-control"), Some("public, max-age=31536000, immutable"));
    let js = String::from_utf8(js).expect("text");
    assert!(js.contains("globalThis.__eosShared[\"react\"]") && js.contains("activate as default"), "{js}");
    assert!(!js.contains("createElement = function"), "React itself is not in the bundle");

    let (status, headers, css) = world.raw(Get, &format!("/ui/plugins/clock/{rev}.css"), None, false).await;
    assert_eq!((status, header(&headers, "content-type")), (200, Some("text/css; charset=utf-8")));
    assert_eq!(String::from_utf8(css).expect("text"), "/* style.css */\n.clock {\n  color: red;\n}\n");

    // A paired computer's window loads the same build without vouching for a user.
    let peer = Caller::Peer { device: "ab:cd".into(), human: false };
    assert_eq!(world.raw_as(Get, &format!("/ui/plugins/clock/{rev}.js"), None, peer).await.0, 200);

    for (missing, body) in [
        (format!("/ui/plugins/clock/{}.js", rev + 1), json!({ "error": "not found" })),
        ("/ui/plugins/nope/1.js".to_owned(), json!({ "error": "not found" })),
        (
            "/ui/plugins/clock/notes.txt".to_owned(),
            json!({ "error": "not found", "path": "/ui/plugins/clock/notes.txt" }),
        ),
    ] {
        assert_eq!(world.call(Get, &missing, None, false).await, (404, body), "{missing}");
    }

    // An edit: a new revision replaces the old one, with no restart.
    world.home.write("plugins/clock/ui.jsx", UI.replace("useState(0)", "useState(7)"));
    changed(&world, &mut events, "clock").await;
    let (_, one) = world.call(Get, "/api/plugins/clock", None, false).await;
    let next = one["plugin"]["rev"].as_i64().expect("a revision");
    assert!(next > rev, "{one}");
    assert_eq!(world.raw(Get, &format!("/ui/plugins/clock/{rev}.js"), None, false).await.0, 404);
    let (_, _, js) = world.raw(Get, &format!("/ui/plugins/clock/{next}.js"), None, false).await;
    assert!(String::from_utf8(js).expect("text").contains("useState)(7)"));

    // A broken edit: the error names the place, and the last good build keeps loading.
    world.home.write("plugins/clock/ui.jsx", "export default function activate() {\n  return <div>\n}\n");
    changed(&world, &mut events, "clock").await;
    let (_, one) = world.call(Get, "/api/plugins/clock/status", None, false).await;
    assert_eq!(one["plugin"]["state"], "error");
    assert_eq!(one["plugin"]["error"], "ui.jsx:4:1: Unexpected end of file before a closing \"div\" tag");
    assert_eq!((&one["plugin"]["rev"], &one["plugin"]["hasUi"]), (&json!(next), &json!(true)));
    assert_eq!(world.raw(Get, &format!("/ui/plugins/clock/{next}.js"), None, false).await.0, 200);

    // The folder goes: so does the plugin.
    std::fs::remove_dir_all(world.home.join("plugins/clock")).expect("removed");
    changed(&world, &mut events, "clock").await;
    assert_eq!(world.call(Get, "/api/plugins/clock", None, false).await.0, 404);
    world.runtime.shutdown(Duration::from_secs(5)).await;
}

fn drawn() -> PluginPreviewResult {
    PluginPreviewResult {
        png: STANDARD.encode(b"\x89PNG\r\n\x1a\n"),
        surface: PluginPreviewSurface::Main,
        view: Some("wall".into()),
        width: 1000.into(),
        height: 760.into(),
        errors: Vec::new(),
        available: PluginPreviewAvailable { main: vec!["wall".into()], panel: Vec::new(), header: Vec::new() },
    }
}

fn fake_build() -> Arc<FakePluginBuilder> {
    Arc::new(FakePluginBuilder::new())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_preview_asks_the_shell_to_draw_the_current_build_and_writes_the_picture_to_a_file() {
    let previewer = Arc::new(FakePluginPreviewer::new(true, drawn()));
    let parts = Parts { previewer: previewer.clone(), builder: fake_build(), ..Parts::default() };
    let world = World::on(clock_home(), parts).await;
    let rev = world.host.plugins.get("clock").expect("listed").rev;
    assert_eq!(
        world.call(Post, "/api/plugins/clock/report", Some(json!({ "rev": rev, "ok": true })), true).await.0,
        200
    );

    let body = json!({ "surface": "main", "store": { "notes": [{ "text": "hi" }] } });
    // No token: the agent writing the plugin asks.
    let (status, shot) = world.call(Post, "/api/plugins/clock/preview", Some(body), false).await;
    assert_eq!(status, 200, "{shot}");
    assert_eq!(shot.get("png"), None, "the picture travels as a file");
    assert_eq!(shot["build"], rev);
    assert_eq!(
        (&shot["surface"], &shot["view"], &shot["width"], &shot["height"], &shot["errors"]),
        (&json!("main"), &json!("wall"), &json!(1000), &json!(760), &json!([]))
    );
    assert_eq!(shot["available"], json!({ "main": ["wall"], "panel": [], "header": [] }));
    let path = std::path::PathBuf::from(shot["path"].as_str().expect("a path"));
    assert_eq!(std::fs::read(&path).expect("the picture"), b"\x89PNG\r\n\x1a\n");
    let name = path.file_name().and_then(|n| n.to_str()).expect("a name");
    assert!(name.starts_with("clock-main-") && name.ends_with(".png"), "{name}");
    let _ = std::fs::remove_dir_all(path.parent().expect("its folder"));

    // The shell was handed the request and the plugin as it stands.
    let calls = previewer.calls();
    assert_eq!(calls.len(), 1);
    let call = serde_json::to_value(&calls[0]).expect("JSON");
    assert_eq!(call["surface"], "main");
    assert_eq!(call["store"], json!({ "notes": [{ "text": "hi" }] }));
    assert_eq!((&call["plugin"]["id"], &call["plugin"]["rev"]), (&json!("clock"), &json!(rev)));

    // Never from another computer: it is drawn by this one's app.
    let peer = Caller::Peer { device: "ab:cd".into(), human: true };
    let (status, _, _) = world.raw_as(Post, "/api/plugins/clock/preview", Some(json!({})), peer).await;
    assert_eq!(status, 403);
    assert_eq!(previewer.calls().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_preview_says_why_a_plugin_cannot_be_drawn() {
    let previewer = Arc::new(FakePluginPreviewer::new(true, drawn()));
    let builder = fake_build();
    let parts = Parts { previewer: previewer.clone(), builder: builder.clone(), ..Parts::default() };
    let world = World::on(clock_home(), parts).await;
    let preview = |body: Value| world.call(Post, "/api/plugins/clock/preview", Some(body), false);

    assert_eq!(
        preview(json!({ "store": { "bad key": 1 } })).await,
        (400, json!({ "error": "invalid request: store: store keys: letters, digits, _ . -" }))
    );
    assert_eq!(preview(json!({ "width": 10 })).await.0, 400);

    builder.fail_next("ui.jsx:3:1: Unexpected");
    world.host.plugins.refresh("clock").await;
    assert_eq!(
        preview(json!({})).await,
        (409, json!({ "error": "can't preview \"clock\": its build failed: ui.jsx:3:1: Unexpected" }))
    );

    world.call(Put, "/api/plugins/clock/enabled", Some(json!({ "enabled": false })), true).await;
    assert_eq!(
        preview(json!({})).await,
        (409, json!({ "error": "can't preview \"clock\": it is turned off in Settings › Plugins" }))
    );
    assert!(previewer.calls().is_empty());

    // An app without a window to draw in.
    let world = World::on(clock_home(), Parts { builder: fake_build(), ..Parts::default() }).await;
    assert_eq!(
        world.call(Post, "/api/plugins/clock/preview", Some(json!({})), false).await,
        (503, json!({ "error": "the Eos app isn't open, so nothing can draw the preview" }))
    );
}

/// A registry in memory: URL → body.
struct Registry(HashMap<String, Vec<u8>>);

impl RegistryHttp for Registry {
    fn get<'a>(&'a self, url: &'a str, _: Option<&'a str>, _: usize) -> BoxFuture<'a, Result<Vec<u8>, HttpFailure>> {
        Box::pin(std::future::ready(self.0.get(url).cloned().ok_or(HttpFailure::Status(404))))
    }
}

fn registry(name: &str, version: &str, package: &[u8]) -> Arc<Registry> {
    let tarball = format!("https://registry.test/{name}/-/{name}-{version}.tgz");
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(package)));
    let meta = json!({
        "dist-tags": { "latest": version },
        "versions": { version: { "dist": { "tarball": tarball, "integrity": integrity } } },
    });
    Arc::new(Registry(HashMap::from([
        (format!("https://registry.test/{name}"), meta.to_string().into_bytes()),
        (tarball, package.to_vec()),
    ])))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_install_from_npm_is_staged_reviewed_swapped_in_and_runs_nothing() {
    let home = TempHome::new();
    let marker = home.join("ran");
    let run = format!("touch '{}'", marker.display());
    // Everything a package could hope to have run: npm's install scripts, an
    // executable file, a build config that names a command.
    let package_json = json!({
        "name": "eos-clock", "version": "1.2.0",
        "scripts": { "preinstall": run, "install": run, "postinstall": run, "prepare": run },
        "dependencies": { "left-pad": "*" },
    })
    .to_string();
    let script = format!("#!/bin/sh\n{run}\n");
    let package = tgz(&[
        ("package/plugin.json", "0000644", br#"{"id":"clock","name":"Clock","version":"1.2.0"}"#),
        ("package/ui.jsx", "0000644", b"export default function activate() {}\n"),
        ("package/package.json", "0000644", package_json.as_bytes()),
        ("package/install.sh", "0000755", script.as_bytes()),
        ("package/.npmrc", "0000644", b"ignore-scripts=false\n"),
    ]);
    let builder: Arc<dyn eos_core::plugin::PluginBuilder> = match support::esbuild() {
        Some(_) => Parts::default().builder,
        None => fake_build(),
    };
    let parts = Parts { registry: registry("eos-clock", "1.2.0", &package), builder, ..Parts::default() };
    let world = World::on(home, parts).await;
    let root = world.root();
    let mut events = world.runtime.kernel.bus.subscribe("plugins:change", 64);
    let source = json!({ "source": { "kind": "npm", "name": "eos-clock" } });

    // Only the user's own dashboard, and never from another computer.
    assert_eq!(world.call(Post, "/api/plugins/install", Some(source.clone()), false).await.0, 403);
    let peer = Caller::Peer { device: "ab:cd".into(), human: true };
    assert_eq!(world.raw_as(Post, "/api/plugins/install", Some(source.clone()), peer.clone()).await.0, 403);
    assert_eq!(world.raw_as(Delete, "/api/plugins/clock", None, peer).await.0, 403);

    let (status, staged) = world.call(Post, "/api/plugins/install", Some(source), true).await;
    assert_eq!(status, 200, "{staged}");
    let staged = &staged["staged"];
    assert_eq!(staged["manifest"]["version"], "1.2.0");
    assert_eq!(staged["resolved"], "https://registry.test/eos-clock/-/eos-clock-1.2.0.tgz");
    assert_eq!(staged["files"], 5);
    assert_eq!(staged["replaces"], Value::Null);
    assert!(staged["integrity"].as_str().is_some_and(|hash| hash.starts_with("sha512-")));
    let stage = staged["stagingId"].as_str().expect("an id").to_owned();
    // Staged is not installed: nothing is in the plugins folder, nothing is listed.
    assert!(exists(&root.join("plugins/.staging").join(&stage).join("plugin.json")));
    assert!(!exists(&root.join("plugins/clock")));
    assert_eq!(world.call(Get, "/api/plugins/clock", None, false).await.0, 404);

    let (status, installed) = world.call(Post, &format!("/api/plugins/install/{stage}"), None, true).await;
    assert_eq!(status, 200, "{installed}");
    assert_eq!((&installed["plugin"]["id"], &installed["plugin"]["state"]), (&json!("clock"), &json!("active")));
    assert_eq!(installed["plugin"]["hasUi"], true);
    assert!(exists(&root.join("plugins/clock/ui.jsx")) && !exists(&root.join("plugins/.staging").join(&stage)));
    changed(&world, &mut events, "clock").await;

    // Where it came from is told to the user's dashboard only.
    let (_, listing) = world.call(Get, "/api/plugins", None, true).await;
    assert_eq!(listing["installs"]["clock"]["source"], json!({ "kind": "npm", "name": "eos-clock" }));
    assert_eq!(listing["installs"]["clock"]["version"], "1.2.0");
    assert_eq!(world.call(Get, "/api/plugins", None, false).await.1.get("installs"), None);
    assert!(exists(&root.join("plugin-data/installed.json")));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(root.join("plugins/clock/install.sh")).expect("the file").permissions().mode();
        assert_eq!(mode & 0o111, 0, "nothing arrives executable");
    }
    assert!(!exists(&root.join("plugins/clock/node_modules")), "no dependency was fetched");

    // An update is staged from the same place and says what it replaces; dropping it leaves the plugin.
    let (status, update) = world.call(Post, "/api/plugins/clock/update", None, true).await;
    assert_eq!(status, 200, "{update}");
    assert_eq!(update["staged"]["replaces"], json!({ "version": "1.2.0", "installed": true }));
    let second = update["staged"]["stagingId"].as_str().expect("an id");
    assert_eq!(
        world.call(Delete, &format!("/api/plugins/install/{second}"), None, true).await,
        (200, json!({ "ok": true }))
    );
    assert!(!exists(&root.join("plugins/.staging").join(second)) && exists(&root.join("plugins/clock")));

    // Removing moves it to the trash, whole.
    assert_eq!(world.call(Delete, "/api/plugins/clock", None, true).await, (200, json!({ "ok": true })));
    assert!(!exists(&root.join("plugins/clock")));
    let trashed: Vec<_> = std::fs::read_dir(root.join("plugins/.trash")).expect("the trash").flatten().collect();
    assert_eq!(trashed.len(), 1);
    assert!(trashed[0].file_name().to_string_lossy().starts_with("clock-"));
    assert!(exists(&trashed[0].path().join("ui.jsx")));
    assert_eq!(world.call(Get, "/api/plugins", None, true).await.1["installs"], json!({}));

    assert!(!exists(&marker), "nothing from the package ran: not at staging, test-build, install, update or removal");
    world.runtime.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_package_that_is_refused_leaves_nothing_behind() {
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "a path that leaves the folder",
            tgz(&[
                ("package/plugin.json", "0000644", br#"{"id":"clock","name":"Clock"}"#),
                ("package/../../escape.txt", "0000644", b"x"),
            ]),
            "eos-clock@1.0.0: the package has a path outside its folder: ../../escape.txt",
        ),
        (
            "a manifest whose UI entry leaves the folder",
            tgz(&[("package/plugin.json", "0000644", br#"{"id":"clock","name":"Clock","ui":"../../other/ui.jsx"}"#)]),
            "not an Eos plugin — plugin.json: ui — must be a file inside the plugin folder",
        ),
        (
            "an id that would name another folder",
            tgz(&[("package/plugin.json", "0000644", br#"{"id":"../clock","name":"Clock"}"#)]),
            "not an Eos plugin — plugin.json: id — lowercase letters, digits, \"-\" and \".\"",
        ),
        (
            "a built-in's id",
            tgz(&[("package/plugin.json", "0000644", br#"{"id":"eos.pages","name":"Pages"}"#)]),
            "the id \"eos.pages\" is reserved for Eos's built-in plugins",
        ),
        ("no manifest", tgz(&[("package/readme.md", "0000644", b"hi")]), "not an Eos plugin — plugin.json is missing"),
    ];
    for (what, package, error) in cases {
        let parts =
            Parts { registry: registry("eos-clock", "1.0.0", &package), builder: fake_build(), ..Parts::default() };
        let world = World::on(TempHome::new(), parts).await;
        let source = json!({ "source": { "kind": "npm", "name": "eos-clock", "version": "1.0.0" } });
        assert_eq!(
            world.call(Post, "/api/plugins/install", Some(source), true).await,
            (400, json!({ "error": error })),
            "{what}"
        );
        let root = world.root();
        assert!(!exists(&root.join("escape.txt")) && !exists(&root.join("plugins/escape.txt")), "{what}");
        let staged = std::fs::read_dir(root.join("plugins/.staging")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(staged, 0, "{what}: the stage is dropped");
        let listed = world.call(Get, "/api/plugins", None, true).await.1;
        assert!(listed["plugins"].as_array().is_some_and(|all| all.iter().all(|p| p["builtin"] == true)), "{what}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stages_left_by_the_last_run_are_gone_after_start() {
    let home = TempHome::new();
    home.write("plugins/.staging/st-0123456789ab/plugin.json", r#"{"id":"left","name":"Left"}"#);
    home.write("plugins/.trash/old-1/plugin.json", "{}");
    let world = World::on(home, Parts { builder: fake_build(), ..Parts::default() }).await;
    let root = world.root();
    assert!(!exists(&root.join("plugins/.staging")));
    assert!(exists(&root.join("plugins/.trash/old-1/plugin.json")), "the trash is kept");
    // Neither dot-folder is a plugin.
    let (_, listing) = world.call(Get, "/api/plugins", None, false).await;
    assert!(listing["plugins"].as_array().is_some_and(|all| all.iter().all(|p| p["builtin"] == true)));
    assert_eq!(world.call(Post, "/api/plugins/install/st-0123456789ab", None, true).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_built_in_that_is_off_turns_its_features_routes_away() {
    // The seeded world carries a stand-in for the pages feature, gated by `eos.pages`.
    let world = World::seeded(Parts { builder: fake_build(), ..Parts::default() }).await;
    let recorded = |step: &str| eos_testkit::fixtures::recorded_response("34-plugins", step);
    assert_eq!(world.call(Get, "/api/pages?all=1", None, true).await.0, 200);

    let off = world.call(Put, "/api/plugins/eos.pages/enabled", Some(json!({ "enabled": false })), true).await;
    assert_eq!((off.0, &off.1), (200, &recorded("builtin-off")["json"]));
    for (method, step) in [(Get, "builtin-off-route"), (Post, "builtin-off-write-route")] {
        let (status, body) = world.call(method, "/api/pages", Some(json!({ "title": "x" })), true).await;
        assert_eq!((json!(status), &body), (recorded(step)["status"].clone(), &recorded(step)["json"]), "{step}");
    }
    assert_eq!(world.host.plugins.disabled_builtins(), ["eos.pages"]);
    // The switch is on disk: it holds after a restart.
    assert!(
        std::fs::read_to_string(world.root().join("plugin-data/enabled.json")).expect("the file").contains("eos.pages")
    );

    let on = world.call(Put, "/api/plugins/eos.pages/enabled", Some(json!({ "enabled": true })), true).await;
    assert_eq!((on.0, &on.1), (200, &recorded("builtin-on")["json"]));
    assert_eq!(world.call(Get, "/api/pages?all=1", None, true).await, (200, json!({ "pages": [] })));
}
