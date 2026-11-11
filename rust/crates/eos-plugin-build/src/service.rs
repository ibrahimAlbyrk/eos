//! One build: a conversation with `esbuild --service=<version>`, the same one
//! esbuild's JavaScript library holds. The host sends a `build` request with
//! the options as command-line flags plus a plugin registration; the binary
//! asks back (`on-resolve`, `on-load`) for the modules the plugin claims and
//! then answers with the output files or the errors.
//!
//! A process per build: nothing stays in memory between builds, and a build
//! that hangs is ended with its deadline.

use std::path::Path;
use std::time::Duration;

use eos_kit_proc::{Command, Env, Event, Runner, Stdin};

use crate::protocol::{Frames, Packet, Value, decode, encode};

/// The esbuild release this conversation was written against. The binary
/// states its own version first; another one is refused, since the packets
/// are private to each release.
pub const ESBUILD_VERSION: &str = "0.28.2";

/// A plugin builds in well under a second; this only ends a build that hangs.
const TIMEOUT: Duration = Duration::from_secs(60);
/// The largest packet read from the binary — in practice the built bundle.
const MAX_PACKET: usize = 64 * 1024 * 1024;
/// What is kept of the binary's stderr to explain a crash.
const MAX_STDERR: usize = 4 * 1024;

/// React and react-dom are never bundled: imports of them resolve to the
/// dashboard's own copy, which it exposes as `globalThis.__eosShared` — a
/// second React would break hooks.
pub const SHARED_MODULES: [&str; 5] =
    ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"];

const SHARED_NAMESPACE: &str = "eos-shared";
/// The callback ids the plugin registration hands out.
const ON_RESOLVE: i32 = 0;
const ON_LOAD: i32 = 1;

const FLAGS: [&str; 13] = [
    "--log-level=silent",
    "--log-limit=0",
    "--target=es2022",
    "--format=esm",
    "--platform=browser",
    "--jsx=automatic",
    "--bundle",
    "--outdir=out",
    "--loader:.svg=text",
    "--loader:.png=dataurl",
    "--loader:.jpg=dataurl",
    "--loader:.gif=dataurl",
    "--loader:.webp=dataurl",
];

/// Where in a source file esbuild found a problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Location {
    /// Relative to the plugin folder.
    pub(crate) file: String,
    pub(crate) line: i32,
    /// Counted from zero.
    pub(crate) column: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Message {
    pub(crate) text: String,
    pub(crate) location: Option<Location>,
}

/// What esbuild answered: errors, or the files it would have written.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Built {
    pub(crate) errors: Vec<Message>,
    /// `(path, text)`.
    pub(crate) outputs: Vec<(String, String)>,
}

/// The build did not get as far as an answer.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum Failure {
    #[error("{0}")]
    Start(String),
    #[error("the bundled esbuild is version {found}, this build of Eos needs {ESBUILD_VERSION}")]
    Version { found: String },
    #[error("the build took longer than {} s and was stopped", TIMEOUT.as_secs())]
    TimedOut,
    #[error("the build's output is larger than {} MB", MAX_PACKET / 1024 / 1024)]
    TooLarge,
    #[error("esbuild stopped before finishing the build{}", detail(.0))]
    Stopped(String),
    #[error("esbuild sent something this build of Eos does not understand ({0})")]
    Protocol(&'static str),
    /// The binary refused the request itself (a bad flag, a bad entry).
    #[error("{0}")]
    Refused(String),
}

fn detail(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
}

fn shared_filter() -> String {
    format!("^({})$", SHARED_MODULES.map(|m| m.replace('/', "\\/")).join("|"))
}

fn build_request(dir: &Path, entry: &Path) -> Value {
    let plugin = Value::object([
        ("name", Value::str(SHARED_NAMESPACE)),
        ("onStart", Value::Bool(false)),
        ("onEnd", Value::Bool(false)),
        (
            "onResolve",
            Value::Array(vec![Value::object([
                ("id", Value::Int(ON_RESOLVE)),
                ("filter", Value::str(shared_filter())),
                ("namespace", Value::str("")),
            ])]),
        ),
        (
            "onLoad",
            Value::Array(vec![Value::object([
                ("id", Value::Int(ON_LOAD)),
                ("filter", Value::str(".*")),
                ("namespace", Value::str(SHARED_NAMESPACE)),
            ])]),
        ),
    ]);
    Value::object([
        ("command", Value::str("build")),
        ("key", Value::Int(0)),
        ("entries", Value::Array(vec![Value::strings(["ui", &entry.to_string_lossy()])])),
        ("flags", Value::strings(FLAGS)),
        ("write", Value::Bool(false)),
        ("stdinContents", Value::Null),
        ("stdinResolveDir", Value::Null),
        ("absWorkingDir", Value::str(dir.to_string_lossy())),
        ("nodePaths", Value::Array(Vec::new())),
        ("context", Value::Bool(false)),
        ("plugins", Value::Array(vec![plugin])),
    ])
}

/// The module a shared import becomes: the dashboard's own copy.
fn shared_module(path: &str) -> Vec<u8> {
    // The path is one of SHARED_MODULES (the filter saw to it): plain text,
    // so quoting it is what JSON.stringify does.
    format!("module.exports = globalThis.__eosShared[\"{path}\"];").into_bytes()
}

/// The answer to something the binary asks while it builds.
fn answer(request: &Value) -> Result<Value, Failure> {
    let callback = || request.get("ids").and_then(|ids| ids.as_array().first()).and_then(Value::as_int);
    let path = || request.get("path").and_then(Value::as_str);
    match request.get("command").and_then(Value::as_str) {
        Some("on-start") => {
            Ok(Value::object([("errors", Value::Array(Vec::new())), ("warnings", Value::Array(Vec::new()))]))
        }
        Some("ping") => Ok(Value::Object(Vec::new())),
        Some("on-resolve") => match (callback(), path()) {
            (Some(id), Some(path)) => Ok(Value::object([
                ("id", Value::Int(id)),
                ("path", Value::str(path)),
                ("namespace", Value::str(SHARED_NAMESPACE)),
            ])),
            _ => Err(Failure::Protocol("on-resolve")),
        },
        Some("on-load") => match (callback(), path()) {
            (Some(id), Some(path)) => Ok(Value::object([
                ("id", Value::Int(id)),
                ("contents", Value::Bytes(shared_module(path))),
                ("loader", Value::str("js")),
            ])),
            _ => Err(Failure::Protocol("on-load")),
        },
        _ => Err(Failure::Protocol("an unknown request")),
    }
}

fn message(value: &Value) -> Message {
    let location = value.get("location").filter(|l| matches!(l, Value::Object(_))).map(|l| Location {
        file: l.get("file").and_then(Value::as_str).unwrap_or_default().to_owned(),
        line: l.get("line").and_then(Value::as_int).unwrap_or_default(),
        column: l.get("column").and_then(Value::as_int).unwrap_or_default(),
    });
    Message { text: value.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(), location }
}

fn built(response: &Value) -> Result<Built, Failure> {
    if let Some(refused) = response.get("error").and_then(Value::as_str) {
        return Err(Failure::Refused(refused.to_owned()));
    }
    let errors = response.get("errors").map(Value::as_array).unwrap_or_default().iter().map(message).collect();
    let outputs = response
        .get("outputFiles")
        .map(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|file| Some((file.get("path")?.as_str()?.to_owned(), file.get("contents")?.text()?)))
        .collect();
    Ok(Built { errors, outputs })
}

async fn send(stdin: &mut Stdin, packet: &Packet) -> Result<(), Failure> {
    stdin.write(&encode(packet)).await.map_err(|_| Failure::Stopped(String::new()))
}

/// Builds `entry` (absolute) with `dir` as the working folder.
pub(crate) async fn build(runner: &Runner, binary: &Path, dir: &Path, entry: &Path) -> Result<Built, Failure> {
    let command = Command::new(binary)
        .arg(format!("--service={ESBUILD_VERSION}"))
        .cwd(dir)
        // Nothing of ours reaches the build, and nothing of the user's shell changes it.
        .env(Env::empty())
        .stdin_open()
        .timeout(TIMEOUT);
    let mut child = runner.spawn(command).map_err(|e| Failure::Start(e.to_string()))?;
    let mut stdin = child.stdin().ok_or_else(|| Failure::Start("esbuild started without a stdin".to_owned()))?;

    let mut frames = Frames::new(MAX_PACKET);
    let mut stderr = Vec::new();
    let mut greeted = false;
    // Dropping `child` on any return below ends the binary and what it started.
    while let Some(event) = child.next().await {
        match event {
            Event::Stdout(chunk) => frames.push(&chunk),
            Event::Stderr(chunk) => {
                let room = MAX_STDERR.saturating_sub(stderr.len());
                stderr.extend_from_slice(&chunk[..chunk.len().min(room)]);
                continue;
            }
            Event::Exit(exit) if exit.timed_out => return Err(Failure::TimedOut),
            Event::Exit(_) => break,
        }
        while let Some(body) = frames.next().map_err(|_| Failure::TooLarge)? {
            if !greeted {
                let found = String::from_utf8_lossy(&body).into_owned();
                if found != ESBUILD_VERSION {
                    return Err(Failure::Version { found });
                }
                greeted = true;
                let request = Packet { id: 0, is_request: true, value: build_request(dir, entry) };
                send(&mut stdin, &request).await?;
                continue;
            }
            let packet = decode(&body).map_err(|_| Failure::Protocol("a malformed packet"))?;
            if packet.is_request {
                let reply = Packet { id: packet.id, is_request: false, value: answer(&packet.value)? };
                send(&mut stdin, &reply).await?;
            } else {
                return built(&packet.value);
            }
        }
    }
    Err(Failure::Stopped(String::from_utf8_lossy(&stderr).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_is_the_one_the_javascript_library_sends() {
        // Captured from esbuild 0.28.2's library for EsbuildPluginBuilder's options.
        let request = build_request(Path::new("/p/clock"), Path::new("/p/clock/ui.jsx"));
        assert_eq!(request.get("command"), Some(&Value::str("build")));
        assert_eq!(request.get("entries"), Some(&Value::Array(vec![Value::strings(["ui", "/p/clock/ui.jsx"])])));
        assert_eq!(request.get("absWorkingDir"), Some(&Value::str("/p/clock")));
        assert_eq!(request.get("write"), Some(&Value::Bool(false)));
        let plugin = &request.get("plugins").expect("plugins").as_array()[0];
        let resolve = &plugin.get("onResolve").expect("onResolve").as_array()[0];
        assert_eq!(
            resolve.get("filter").and_then(Value::as_str),
            Some(r"^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client)$")
        );
        let keys: Vec<&str> = match &request {
            Value::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
            _ => Vec::new(),
        };
        assert_eq!(
            keys,
            [
                "command",
                "key",
                "entries",
                "flags",
                "write",
                "stdinContents",
                "stdinResolveDir",
                "absWorkingDir",
                "nodePaths",
                "context",
                "plugins"
            ]
        );
    }

    #[test]
    fn shared_imports_resolve_to_the_dashboards_copy() {
        let asked = Value::object([
            ("command", Value::str("on-resolve")),
            ("ids", Value::Array(vec![Value::Int(0)])),
            ("path", Value::str("react/jsx-runtime")),
        ]);
        assert_eq!(
            answer(&asked),
            Ok(Value::object([
                ("id", Value::Int(0)),
                ("path", Value::str("react/jsx-runtime")),
                ("namespace", Value::str("eos-shared")),
            ]))
        );
        let load = Value::object([
            ("command", Value::str("on-load")),
            ("ids", Value::Array(vec![Value::Int(1)])),
            ("path", Value::str("react-dom/client")),
        ]);
        let contents = answer(&load).expect("answers");
        assert_eq!(
            contents.get("contents"),
            Some(&Value::Bytes(b"module.exports = globalThis.__eosShared[\"react-dom/client\"];".to_vec()))
        );
        assert_eq!(
            answer(&Value::object([("command", Value::str("serve"))])),
            Err(Failure::Protocol("an unknown request"))
        );
    }

    #[test]
    fn an_answer_is_errors_or_output_files() {
        let failed = Value::object([(
            "errors",
            Value::Array(vec![Value::object([
                ("text", Value::str("Could not resolve \"lodash\"")),
                (
                    "location",
                    Value::object([
                        ("file", Value::str("ui.jsx")),
                        ("line", Value::Int(1)),
                        ("column", Value::Int(14)),
                    ]),
                ),
            ])]),
        )]);
        let out = built(&failed).expect("an answer");
        assert_eq!(out.errors[0].location, Some(Location { file: "ui.jsx".into(), line: 1, column: 14 }));
        assert!(out.outputs.is_empty());

        let ok = Value::object([(
            "outputFiles",
            Value::Array(vec![Value::object([
                ("path", Value::str("/p/out/ui.js")),
                ("contents", Value::Bytes(b"export{};".to_vec())),
            ])]),
        )]);
        assert_eq!(built(&ok).expect("an answer").outputs, vec![("/p/out/ui.js".to_owned(), "export{};".to_owned())]);
        assert_eq!(
            built(&Value::object([("error", Value::str("Invalid build flag: \"--nope\""))])),
            Err(Failure::Refused("Invalid build flag: \"--nope\"".into()))
        );
    }

    #[test]
    fn failures_read_as_sentences() {
        assert_eq!(Failure::TimedOut.to_string(), "the build took longer than 60 s and was stopped");
        assert_eq!(Failure::TooLarge.to_string(), "the build's output is larger than 64 MB");
        assert_eq!(Failure::Stopped(String::new()).to_string(), "esbuild stopped before finishing the build");
        assert_eq!(
            Failure::Stopped("panic: x\n".into()).to_string(),
            "esbuild stopped before finishing the build: panic: x"
        );
        assert_eq!(
            Failure::Version { found: "0.25.0".into() }.to_string(),
            "the bundled esbuild is version 0.25.0, this build of Eos needs 0.28.2"
        );
    }
}
