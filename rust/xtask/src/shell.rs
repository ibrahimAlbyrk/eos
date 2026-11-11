//! `cargo xtask shell` checks the rules of the window shell that the compiler cannot:
//!
//! - every web view is created in one place and with `no_bridge`, so no page in Eos has
//!   `window.ipc` or any Tauri script (the condition of the shell gate);
//! - no Tauri command, event script or scheme protocol is registered: pages reach Rust only
//!   through the in-process handler of the app's own origin;
//! - `unsafe` appears only in the shell's `native` module;
//! - Tauri and CEF types stay inside `eos-shell`.
//!
//! It reads source text, so it runs without building Tauri or CEF.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

/// The one file that may create a web view.
const VIEW_FACTORY: &str = "host/eos-shell/src/views/create.rs";
/// The one module tree that may use `unsafe`.
const NATIVE: &str = "host/eos-shell/src/native/";

/// Ways to create a view. Only the factory may use the first; nothing may use the rest.
const VIEW_BUILDER: &str = "WebviewBuilder::new";
const OTHER_VIEW_BUILDERS: [&str; 3] = ["WebviewWindowBuilder", "WebviewBuilder::from_config", "WebviewUrl::App"];

/// Tauri's own page-facing surfaces: none may be used.
const PAGE_SURFACES: [&str; 6] = [
    "invoke_handler",
    "generate_handler",
    "tauri::command",
    "register_uri_scheme_protocol",
    "register_asynchronous_uri_scheme_protocol",
    "initialization_script",
];

/// Crates that must not name Tauri or CEF at all.
const TAURI_FREE: [&str; 3] = ["crates/eos-bridge/src", "crates/eos-core/src", "host/eos/src"];

/// The code of a source file without its line comments.
fn code(source: &str) -> String {
    source.lines().map(|line| line.split_once("//").map_or(line, |(code, _)| code)).collect::<Vec<_>>().join("\n")
}

fn has_word(code: &str, word: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    code.match_indices(word).any(|(at, _)| {
        let before = code[..at].chars().next_back();
        let after = code[at + word.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

/// What is wrong with one file, given its path relative to the workspace root.
fn problems(path: &str, source: &str) -> Vec<String> {
    let code = code(source);
    let mut found = Vec::new();
    let in_shell = path.starts_with("host/eos-shell/src/");
    if in_shell {
        if path == VIEW_FACTORY {
            let builders = code.matches(VIEW_BUILDER).count();
            let bridged = code.matches(".no_bridge(true)").count();
            if builders == 0 || builders != bridged || code.contains("no_bridge(false)") {
                found.push(format!("{path}: every `{VIEW_BUILDER}` must be followed by `.no_bridge(true)` ({builders} builders, {bridged} without a bridge)"));
            }
        } else if code.contains(VIEW_BUILDER) {
            found.push(format!("{path}: a web view may only be created in {VIEW_FACTORY}"));
        }
        for other in OTHER_VIEW_BUILDERS {
            if code.contains(other) {
                found.push(format!("{path}: `{other}` creates a view with Tauri's bridge"));
            }
        }
        for surface in PAGE_SURFACES {
            if code.contains(surface) {
                found.push(format!(
                    "{path}: `{surface}` gives pages a Tauri surface; use a route of the app's own origin"
                ));
            }
        }
        if !path.starts_with(NATIVE) && has_word(&code, "unsafe") {
            found.push(format!("{path}: `unsafe` belongs in {NATIVE}"));
        }
    }
    if path == "host/eos-shell/src/lib.rs" || TAURI_FREE.iter().any(|dir| path.starts_with(dir)) {
        for name in ["tauri", "cef"] {
            if code
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .any(|word| word == name || word.starts_with(&format!("{name}_")))
            {
                found.push(format!(
                    "{path}: names `{name}`; Tauri and CEF types stay inside eos-shell's private modules"
                ));
            }
        }
    }
    found
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.is_dir() {
            rust_files(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

pub(crate) fn check() -> anyhow::Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().context("workspace root")?;
    let mut files = Vec::new();
    for dir in ["host/eos-shell/src", "host/eos/src", "crates/eos-bridge/src", "crates/eos-core/src"] {
        rust_files(&root.join(dir), &mut files)?;
    }
    if !files.iter().any(|f| f.ends_with(VIEW_FACTORY)) {
        bail!("{VIEW_FACTORY} is missing: the shell guard does not know where views are created");
    }
    let mut all = Vec::new();
    for file in &files {
        let relative = file.strip_prefix(root).unwrap_or(file).to_string_lossy().replace('\\', "/");
        all.extend(problems(&relative, &std::fs::read_to_string(file)?));
    }
    if all.is_empty() {
        println!("shell ok ({} files)", files.len());
        Ok(())
    } else {
        bail!("shell rules violated:\n  {}", all.join("\n  "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FACTORY: &str = "let b = WebviewBuilder::new(label, blank())\n    .no_bridge(true)\n    .focused(false);";

    #[test]
    fn the_factory_must_create_views_without_a_bridge() {
        assert!(problems(VIEW_FACTORY, FACTORY).is_empty());
        assert_eq!(problems(VIEW_FACTORY, "let b = WebviewBuilder::new(label, blank());").len(), 1);
        assert_eq!(problems(VIEW_FACTORY, &FACTORY.replace("true", "false")).len(), 1);
        assert_eq!(
            problems(VIEW_FACTORY, &format!("{FACTORY}\nlet c = WebviewBuilder::new(l, u);")).len(),
            1,
            "a second builder without it"
        );
        assert_eq!(
            problems(VIEW_FACTORY, "// WebviewBuilder::new(..).no_bridge(true)").len(),
            1,
            "a comment is not a builder"
        );
    }

    #[test]
    fn nowhere_else_may_a_view_be_created() {
        let elsewhere = "host/eos-shell/src/app.rs";
        assert_eq!(problems(elsewhere, FACTORY).len(), 1);
        assert_eq!(problems(elsewhere, "tauri::WebviewWindowBuilder::new(app, \"w\", url)").len(), 1);
        assert_eq!(problems(elsewhere, "WebviewUrl::App(\"index.html\".into())").len(), 1);
        assert!(problems(elsewhere, "// WebviewBuilder::new is only for create.rs").is_empty());
    }

    #[test]
    fn no_tauri_surface_for_pages() {
        let file = "host/eos-shell/src/app.rs";
        for bad in [
            ".invoke_handler(tauri::generate_handler![x])",
            "#[tauri::command]\nfn x() {}",
            ".register_uri_scheme_protocol(\"eos\", f)",
            ".initialization_script(js)",
        ] {
            assert!(!problems(file, bad).is_empty(), "{bad}");
        }
    }

    #[test]
    fn unsafe_only_in_native() {
        assert_eq!(problems("host/eos-shell/src/scheme.rs", "let p = unsafe { *ptr };").len(), 1);
        assert!(problems("host/eos-shell/src/native/buffer.rs", "let p = unsafe { *ptr };").is_empty());
        assert!(problems("host/eos-shell/src/scheme.rs", "// no unsafe here\nlet unsafe_code = 1;").is_empty());
    }

    #[test]
    fn tauri_and_cef_stay_inside_the_shell() {
        assert_eq!(problems("host/eos/src/main.rs", "use tauri::Manager;").len(), 1);
        assert_eq!(problems("crates/eos-bridge/src/transport.rs", "fn f(b: cef::Browser) {}").len(), 1);
        assert_eq!(problems("host/eos-shell/src/lib.rs", "pub fn window() -> tauri::Window {}").len(), 1);
        assert_eq!(problems("host/eos/src/main.rs", "use tauri_runtime_cef::Cef;").len(), 2 - 1);
        assert!(
            problems("host/eos/src/main.rs", "// starts the Tauri shell\nfn main() { eos_shell::run(o, h); }")
                .is_empty()
        );
        assert!(problems("crates/eos-bridge/src/lib.rs", "let certificate = 1; let x = \"no Tauri type\";").is_empty());
        // Inside the shell's private modules they are the point.
        assert!(problems("host/eos-shell/src/window.rs", "use tauri::Window;").is_empty());
    }
}
