//! Builds a plugin's UI entry into one ES module (plus one stylesheet when it
//! imports CSS) by driving the esbuild binary the app ships — the
//! [`PluginBuilder`] port.
//!
//! The build is the one esbuild's JavaScript library ran for the TypeScript
//! daemon: same options, same shared-module plugin, so the bundle is the same
//! text byte for byte and errors read the same. React and react-dom are not
//! bundled ([`SHARED_MODULES`]); nothing else outside the folder resolves, so
//! a plugin is self-contained by construction.
//!
//! ```text
//! let binary = locate(bundled_path, dev_checkout().as_deref());
//! let builder = EsbuildPluginBuilder::new(runner, binary);
//! ```

mod locate;
mod protocol;
mod service;

use std::path::{Path, PathBuf};

use eos_core::plugin::{PluginBuild, PluginBuilder};
use eos_core::{BoxFuture, Error};
use eos_kit_proc::Runner;
use tokio::sync::Semaphore;

pub use locate::{dev_checkout, locate};
pub use service::{ESBUILD_VERSION, SHARED_MODULES};
use service::{Location, Message};

/// Builds running at once. Each is a process that uses every core for a
/// moment; at start-up every plugin asks for one.
const CONCURRENT_BUILDS: usize = 2;

#[derive(Debug)]
pub struct EsbuildPluginBuilder {
    runner: Runner,
    binary: Option<PathBuf>,
    slots: Semaphore,
}

impl EsbuildPluginBuilder {
    /// `binary`: what [`locate`] found. Without one every build fails with a
    /// message that says so.
    pub fn new(runner: Runner, binary: Option<PathBuf>) -> Self {
        Self { runner, binary, slots: Semaphore::new(CONCURRENT_BUILDS) }
    }
}

/// Node's `join(dir, entry)`: the entry is always taken as relative.
fn entry_path(dir: &Path, entry: &str) -> PathBuf {
    dir.join(entry.trim_start_matches(['/', '\\']))
}

/// A path as the author knows it: relative to the plugin folder, `.` and
/// `..` resolved by the text (`relative(dir, join(dir, file)) || file`).
fn shown_path(dir: &Path, file: &str) -> String {
    let dir_text = dir.to_string_lossy();
    let base: Vec<&str> = dir_text.split('/').filter(|s| !s.is_empty()).collect();
    let mut joined = base.clone();
    for segment in file.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                joined.pop();
            }
            name => joined.push(name),
        }
    }
    let common = base.iter().zip(&joined).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; base.len() - common];
    parts.extend(&joined[common..]);
    if parts.is_empty() { file.to_owned() } else { parts.join("/") }
}

/// One error the way the author reads it: `ui.jsx:3:1: Unexpected "}"`.
fn describe(message: &Message, dir: &Path) -> String {
    let place = match &message.location {
        Some(Location { file, line, column }) => format!("{}:{line}:{}: ", shown_path(dir, file), column + 1),
        None => String::new(),
    };
    // A bare import that did not resolve: say what a plugin may import.
    let bare = message
        .text
        .strip_prefix("Could not resolve \"")
        .and_then(|rest| rest.chars().next())
        .is_some_and(|first| first != '.' && first != '/');
    let hint = if bare {
        format!(" — a plugin can import only its own files and {}", SHARED_MODULES.join(", "))
    } else {
        String::new()
    };
    format!("{place}{}{hint}", message.text)
}

impl PluginBuilder for EsbuildPluginBuilder {
    fn build<'a>(&'a self, dir: &'a Path, entry: &'a str) -> BoxFuture<'a, Result<PluginBuild, Error>> {
        Box::pin(async move {
            let Some(binary) = &self.binary else {
                return Err(Error::Rule("this copy of Eos has no esbuild to build plugins with".to_owned()));
            };
            let _slot = self.slots.acquire().await.map_err(Error::storage)?;
            let built = service::build(&self.runner, binary, dir, &entry_path(dir, entry))
                .await
                .map_err(|failure| Error::Rule(failure.to_string()))?;
            if !built.errors.is_empty() {
                let text: Vec<String> = built.errors.iter().map(|m| describe(m, dir)).collect();
                return Err(Error::Rule(text.join("\n")));
            }
            let output = |suffix: &str| {
                built.outputs.iter().find(|(path, _)| path.ends_with(suffix)).map(|(_, text)| text.clone())
            };
            Ok(PluginBuild { js: output(".js").unwrap_or_default(), css: output(".css") })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(file: &str, line: i32, column: i32, text: &str) -> Message {
        Message { text: text.to_owned(), location: Some(Location { file: file.to_owned(), line, column }) }
    }

    #[test]
    fn errors_name_the_place_one_based_and_hint_at_bare_imports() {
        let dir = Path::new("/h/plugins/clock");
        assert_eq!(
            describe(&at("ui.jsx", 1, 14, "Could not resolve \"lodash\""), dir),
            "ui.jsx:1:15: Could not resolve \"lodash\" — a plugin can import only its own files and react, \
             react/jsx-runtime, react/jsx-dev-runtime, react-dom, react-dom/client"
        );
        assert_eq!(
            describe(&at("ui.jsx", 2, 14, "Could not resolve \"./missing.js\""), dir),
            "ui.jsx:2:15: Could not resolve \"./missing.js\""
        );
        assert_eq!(
            describe(&Message { text: "No loader is configured".into(), location: None }, dir),
            "No loader is configured"
        );
    }

    #[test]
    fn paths_are_shown_relative_to_the_plugin_folder() {
        let dir = Path::new("/h/plugins/clock");
        assert_eq!(shown_path(dir, "lib/./label.ts"), "lib/label.ts");
        assert_eq!(shown_path(dir, "../notes/ui.jsx"), "../notes/ui.jsx");
        assert_eq!(shown_path(dir, "../clock/ui.jsx"), "ui.jsx");
        assert_eq!(shown_path(dir, "eos-shared:react"), "eos-shared:react");
        assert_eq!(shown_path(dir, "."), ".", "nothing left: the name as given");
    }

    #[test]
    fn the_entry_is_always_inside_the_folder() {
        let dir = Path::new("/h/plugins/clock");
        assert_eq!(entry_path(dir, "ui.jsx"), Path::new("/h/plugins/clock/ui.jsx"));
        assert_eq!(entry_path(dir, "/src/ui.tsx"), Path::new("/h/plugins/clock/src/ui.tsx"));
    }

    #[tokio::test]
    async fn without_a_binary_a_build_says_so() {
        let runner = Runner::new(eos_kit_proc::ProcessTrees::new(|_| {}, |_| false));
        let builder = EsbuildPluginBuilder::new(runner, None);
        let err = builder.build(Path::new("/p"), "ui.jsx").await.expect_err("no binary");
        assert_eq!(err.to_string(), "this copy of Eos has no esbuild to build plugins with");
    }
}
