use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_cli::{Launcher, Place, Terminal, run};
use eos_contracts::cli::exit;
use serde_json::{Value, json};

static N: AtomicU32 = AtomicU32::new(0);

/// A short folder under /tmp (a socket path has at most 104 bytes), removed on drop.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path = PathBuf::from(format!("/tmp/eos-cli-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("a folder");
        Folder(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

type Script = dyn Fn(&Value) -> Vec<Value> + Send + Sync;

/// A gateway that answers `hello` and every other request by `script`, and keeps the
/// requests it was sent.
fn serve(folder: &Path, script: Arc<Script>) -> Arc<Mutex<Vec<Value>>> {
    let listener = UnixListener::bind(folder.join("cli.sock")).expect("binds");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let kept = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let frames = if request["cmd"] == "hello" {
                vec![json!({"t": "hello", "version": "0.2.0", "ready": true}), json!({"t": "done", "exit": 0})]
            } else {
                kept.lock().expect("lock").push(request.clone());
                script(&request)
            };
            for frame in frames {
                let _ = writeln!(stream, "{frame}");
            }
        }
    });
    seen
}

#[derive(Default)]
struct Fake {
    piped: Option<Cursor<Vec<u8>>>,
    interactive: bool,
    agree: bool,
    out: Vec<String>,
    err: Vec<String>,
    asked: Vec<String>,
}

impl Terminal for Fake {
    fn piped(&mut self) -> Option<&mut dyn Read> {
        self.piped.as_mut().map(|p| p as &mut dyn Read)
    }

    fn interactive(&self) -> bool {
        self.interactive
    }

    fn out(&mut self, line: &str) {
        self.out.push(line.to_owned());
    }

    fn err(&mut self, line: &str) {
        self.err.push(line.to_owned());
    }

    fn confirm(&mut self, question: &str) -> bool {
        self.asked.push(question.to_owned());
        self.agree
    }
}

/// Starts nothing, or starts the fake gateway when asked to launch.
struct FakeLauncher {
    starts: Option<(PathBuf, Arc<Script>)>,
    launched: AtomicU32,
}

impl Launcher for FakeLauncher {
    fn launch(&self) -> bool {
        self.launched.fetch_add(1, Ordering::SeqCst);
        if let Some((folder, script)) = &self.starts {
            let (folder, script) = (folder.clone(), script.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                serve(&folder, script);
            });
        }
        self.starts.is_some()
    }
}

fn no_launch() -> FakeLauncher {
    FakeLauncher { starts: None, launched: AtomicU32::new(0) }
}

fn place(folder: &Folder) -> Place {
    Place { shell_data: folder.0.clone(), start_within: Duration::from_secs(5) }
}

fn line(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| (*w).to_owned()).collect()
}

fn answers(frames: Vec<Value>) -> Arc<Script> {
    Arc::new(move |_| frames.clone())
}

#[test]
fn a_command_goes_to_the_gateway_and_its_lines_and_code_come_back() {
    let folder = Folder::new();
    let seen = serve(
        &folder.0,
        answers(vec![
            json!({"t": "err", "text": "running · work"}),
            json!({"t": "out", "text": "Two problems found"}),
            json!({"t": "done", "exit": 1}),
        ]),
    );
    let mut terminal = Fake::default();
    let code = run(
        &line(&["run", "pr-review", "482", "--wait"]),
        Path::new("/w"),
        &place(&folder),
        &mut terminal,
        &no_launch(),
    );
    assert_eq!(code, exit::RUN_FAILED);
    assert_eq!(
        (terminal.out, terminal.err),
        (vec!["Two problems found".to_owned()], vec!["running · work".to_owned()])
    );
    let sent = &seen.lock().expect("lock")[0];
    assert_eq!(
        (sent["cmd"].as_str(), sent["routine"].as_str(), sent["items"][0].as_str()),
        (Some("run"), Some("pr-review"), Some("482"))
    );
    assert_eq!(sent["wait"], true);
}

#[test]
fn piped_text_is_one_more_item_up_to_one_mib() {
    let folder = Folder::new();
    let seen = serve(&folder.0, answers(vec![json!({"t": "done", "exit": 0})]));
    let mut terminal = Fake { piped: Some(Cursor::new(b"a stack trace".to_vec())), ..Fake::default() };
    assert_eq!(
        run(&line(&["once", "Explain this"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()),
        exit::OK
    );
    assert_eq!(seen.lock().expect("lock")[0]["stdin"], "a stack trace");

    let too_big = vec![b'x'; eos_contracts::cli::CLI_STDIN_MAX_BYTES + 1];
    let mut terminal = Fake { piped: Some(Cursor::new(too_big)), ..Fake::default() };
    assert_eq!(
        run(&line(&["once", "Explain this"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()),
        exit::REFUSED
    );
    assert!(terminal.err[0].contains("over 1 MiB"));
    assert_eq!(seen.lock().expect("lock").len(), 1, "nothing was sent");
}

#[test]
fn bad_usage_ends_with_two_and_help_with_zero() {
    let folder = Folder::new();
    let mut terminal = Fake::default();
    assert_eq!(run(&line(&["dance"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()), exit::REFUSED);
    assert_eq!(run(&line(&["help"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()), exit::OK);
    assert!(terminal.out[0].starts_with("eos: start Eos routines"));
}

#[test]
fn without_the_app_the_command_starts_it_hidden_or_ends_with_three() {
    let folder = Folder::new();
    let mut terminal = Fake::default();
    let nothing = no_launch();
    assert_eq!(run(&line(&["routines"]), Path::new("/w"), &place(&folder), &mut terminal, &nothing), exit::UNREACHABLE);
    assert!(terminal.err[0].starts_with("Eos is not running"));

    let script = answers(vec![json!({"t": "out", "text": "pr-review"}), json!({"t": "done", "exit": 0})]);
    let starts = FakeLauncher { starts: Some((folder.0.clone(), script)), launched: AtomicU32::new(0) };
    let mut terminal = Fake::default();
    assert_eq!(run(&line(&["routines"]), Path::new("/w"), &place(&folder), &mut terminal, &starts), exit::OK);
    assert_eq!((terminal.err[0].as_str(), terminal.out[0].as_str()), ("Starting Eos…", "pr-review"));
    assert_eq!(starts.launched.load(Ordering::SeqCst), 1);

    let late = Folder::new();
    let mut terminal = Fake::default();
    let quick = Place { shell_data: late.0.clone(), start_within: Duration::from_millis(600) };
    // A launcher that says it started the app, but no gateway ever answers.
    struct Claims;
    impl Launcher for Claims {
        fn launch(&self) -> bool {
            true
        }
    }
    assert_eq!(run(&line(&["routines"]), Path::new("/w"), &quick, &mut terminal, &Claims), exit::UNREACHABLE);
    assert_eq!(terminal.err, ["Starting Eos…", "Eos did not start in time."]);
}

fn confirming() -> Arc<Script> {
    Arc::new(|request: &Value| {
        if request["yes"] == true {
            vec![json!({"t": "out", "text": "Started 2 runs of PR Review."}), json!({"t": "done", "exit": 0})]
        } else {
            vec![
                json!({"t": "confirm", "text": "Start 2 runs of PR Review? About $1.50 in all."}),
                json!({"t": "done", "exit": 2}),
            ]
        }
    })
}

#[test]
fn several_runs_are_asked_on_a_terminal_and_need_yes_off_one() {
    let folder = Folder::new();
    let seen = serve(&folder.0, confirming());
    let mut terminal = Fake { interactive: true, agree: true, ..Fake::default() };
    assert_eq!(
        run(&line(&["run", "pr-review", "1", "2"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()),
        exit::OK
    );
    assert_eq!(terminal.asked, ["Start 2 runs of PR Review? About $1.50 in all."]);
    assert_eq!(seen.lock().expect("lock").iter().map(|r| r["yes"] == true).collect::<Vec<_>>(), [false, true]);

    let mut piped = Fake::default();
    assert_eq!(
        run(&line(&["run", "pr-review", "1", "2"]), Path::new("/w"), &place(&folder), &mut piped, &no_launch()),
        exit::REFUSED
    );
    assert!(piped.err[0].ends_with("Add --yes to start them."));
    assert_eq!(seen.lock().expect("lock").len(), 3, "off a terminal nothing more was sent");
}

#[test]
fn a_gateway_that_stops_answering_ends_with_three() {
    let folder = Folder::new();
    serve(&folder.0, answers(vec![json!({"t": "out", "text": "half"})]));
    let mut terminal = Fake::default();
    assert_eq!(
        run(&line(&["routines"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()),
        exit::UNREACHABLE
    );
    assert_eq!(terminal.err, ["Eos stopped answering."]);
}

#[test]
fn halt_and_resume_go_to_the_gateway() {
    let folder = Folder::new();
    let seen = serve(
        &folder.0,
        answers(vec![json!({"t": "out", "text": "Routines stopped."}), json!({"t": "done", "exit": 0})]),
    );
    let mut terminal = Fake::default();
    assert_eq!(run(&line(&["halt"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()), exit::OK);
    assert_eq!(run(&line(&["resume"]), Path::new("/w"), &place(&folder), &mut terminal, &no_launch()), exit::OK);
    let cmds: Vec<Value> = seen.lock().expect("lock").iter().map(|r| r["cmd"].clone()).collect();
    assert_eq!(cmds, [json!("halt"), json!("resume")]);
}

#[test]
fn a_memory_hook_prints_the_answer_or_nothing_and_never_starts_the_app() {
    let folder = Folder::new();
    let answer = json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Use --release."}});
    let seen = serve(&folder.0, answers(vec![json!({"t": "json", "value": answer}), json!({"t": "done", "exit": 0})]));
    let input = br#"{"tool_name":"Bash","tool_input":{"command":"cargo test"}}"#.to_vec();
    let mut terminal = Fake { piped: Some(Cursor::new(input)), ..Fake::default() };
    let hook = line(&["memory", "hook", "--event", "PreToolUse"]);
    assert_eq!(run(&hook, Path::new("/w"), &place(&folder), &mut terminal, &no_launch()), exit::OK);
    assert_eq!(terminal.out, [answer.to_string()]);
    let sent = &seen.lock().expect("lock")[0];
    assert_eq!((sent["cmd"].as_str(), sent["event"].as_str()), (Some("memoryHook"), Some("PreToolUse")));
    assert_eq!(sent["input"]["tool_name"], "Bash");

    // A gateway that answers too late: nothing is printed, and the tool is held at most 300 ms.
    let slow = Folder::new();
    serve(
        &slow.0,
        Arc::new(|_: &Value| {
            std::thread::sleep(Duration::from_millis(800));
            vec![json!({"t": "json", "value": {"late": true}}), json!({"t": "done", "exit": 0})]
        }),
    );
    let mut terminal = Fake::default();
    let began = std::time::Instant::now();
    assert_eq!(run(&hook, Path::new("/w"), &place(&slow), &mut terminal, &no_launch()), exit::OK);
    assert!(began.elapsed() < Duration::from_millis(600), "{:?}", began.elapsed());
    assert!(terminal.out.is_empty() && terminal.err.is_empty());

    // No app: nothing, and nothing is started.
    let none = Folder::new();
    let launcher = no_launch();
    let mut terminal = Fake::default();
    assert_eq!(run(&hook, Path::new("/w"), &place(&none), &mut terminal, &launcher), exit::OK);
    assert!(terminal.out.is_empty() && terminal.err.is_empty());
    assert_eq!(launcher.launched.load(Ordering::SeqCst), 0);
}
