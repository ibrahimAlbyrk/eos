//! A stand-in for Claude Code in a Code-view pane, for tests: no model, no
//! network. It speaks just enough of the real program's terminal protocol:
//!
//! - `--session-id <id>` starts a conversation, `--resume <id>` continues one
//!   (and fails when it has no transcript, as the real one does);
//! - the `--settings` hooks are run the way Claude Code runs them: each
//!   command through `sh -c` with the hook's JSON on stdin;
//! - a bracketed paste lands in the composer, Enter submits it, and every
//!   entry is appended to the transcript where Claude Code keeps it;
//! - a prompt containing `ask` opens an AskUserQuestion dialog and `plan` an
//!   ExitPlanMode one (a digit answers), `/clear` moves to a new conversation,
//!   `/exit` leaves.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

struct Pane {
    id: String,
    settings: Value,
    home: PathBuf,
    cwd: String,
    entries: u64,
    last: Option<String>,
}

/// An instant as Claude writes it (`2026-09-27T10:00:00.000Z`).
fn now_iso() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Civil date from days since 1970-01-01.
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

impl Pane {
    fn transcript(&self) -> PathBuf {
        let encoded = eos_domain::claude_transcript::encode_cwd(&self.cwd);
        self.home.join(".claude/projects").join(encoded).join(format!("{}.jsonl", self.id))
    }

    fn append(&mut self, mut entry: Value) {
        self.entries += 1;
        let uuid = format!("{}-{}", &self.id[..8], self.entries);
        entry["uuid"] = json!(uuid);
        entry["parentUuid"] = json!(self.last);
        entry["timestamp"] = json!(now_iso());
        entry["isSidechain"] = json!(false);
        let path = self.transcript();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{entry}");
        }
        self.last = Some(uuid);
    }

    fn user(&mut self, content: Value) {
        self.append(json!({ "type": "user", "message": { "role": "user", "content": content } }));
    }

    fn assistant(&mut self, content: Value, stop: &str) {
        self.append(
            json!({ "type": "assistant", "message": { "role": "assistant", "content": content, "stop_reason": stop } }),
        );
    }

    fn turn_end(&mut self) {
        let parent = self.last.clone();
        self.append(json!({ "type": "system", "subtype": "turn_duration" }));
        // The marker hangs off the branch tip; the next entry continues from the tip.
        self.last = parent;
    }

    /// Runs the hooks of `event` whose matcher fits `tool`, with `input` on stdin.
    fn hooks(&self, event: &str, tool: Option<&str>, input: &Value) {
        let groups = self.settings["hooks"][event].as_array().cloned().unwrap_or_default();
        for group in groups {
            let fits = match (group["matcher"].as_str(), tool) {
                (Some(matcher), Some(tool)) => matcher.split('|').any(|name| name == tool),
                _ => true,
            };
            if !fits {
                continue;
            }
            for hook in group["hooks"].as_array().cloned().unwrap_or_default() {
                let Some(command) = hook["command"].as_str() else { continue };
                let child = Command::new("/bin/sh").args(["-c", command]).stdin(Stdio::piped()).spawn();
                if let Ok(mut child) = child {
                    if let Some(mut stdin) = child.stdin.take() {
                        let _ = stdin.write_all(input.to_string().as_bytes());
                    }
                    let _ = child.wait();
                }
            }
        }
    }

    fn session_started(&self) {
        self.hooks("SessionStart", None, &json!({ "hook_event_name": "SessionStart", "session_id": self.id }));
    }

    /// Opens a dialog: the hook reports it, a digit answers it.
    fn dialog(&mut self, name: &str, call_id: &str, input: Value, keys: &mut impl Iterator<Item = u8>) {
        let report =
            json!({ "hook_event_name": "PreToolUse", "tool_name": name, "tool_use_id": call_id, "tool_input": input });
        self.hooks("PreToolUse", Some(name), &report);
        say(&format!("\r\n[{name}] 1-9 to answer\r\n"));
        let digit = keys.find(u8::is_ascii_digit).map_or('?', char::from);
        // Claude writes the call to its transcript only once it is answered.
        self.assistant(json!([{ "type": "tool_use", "id": call_id, "name": name, "input": input }]), "tool_use");
        self.user(json!([{ "type": "tool_result", "tool_use_id": call_id, "content": format!("answered {digit}") }]));
        self.assistant(json!([{ "type": "text", "text": format!("You picked {digit}.") }]), "end_turn");
        self.turn_end();
        say(&format!("You picked {digit}.\r\n> "));
    }

    fn submit(&mut self, prompt: &str, keys: &mut impl Iterator<Item = u8>) -> bool {
        match prompt.trim() {
            "/exit" => return false,
            "/clear" => {
                // A new conversation under a new id, announced through the session hook.
                self.id = format!("{:08x}-0000-4000-8000-{:012x}", std::process::id(), self.entries + 1);
                self.last = None;
                self.session_started();
                say("\r\ncleared\r\n> ");
                return true;
            }
            _ => {}
        }
        self.user(json!(prompt));
        if prompt.contains("ask") {
            let ask = json!({ "questions": [{ "question": "Which colour?", "header": "Colour", "multiSelect": false,
                "options": [{ "label": "Red" }, { "label": "Blue" }] }] });
            self.dialog("AskUserQuestion", &format!("toolu_ask{}", self.entries), ask, keys);
        } else if prompt.contains("plan") {
            let plan = json!({ "plan": "1. do it" });
            self.dialog("ExitPlanMode", &format!("toolu_plan{}", self.entries), plan, keys);
        } else {
            self.assistant(json!([{ "type": "text", "text": format!("echo: {prompt}") }]), "end_turn");
            self.turn_end();
            say(&format!("\r\necho: {prompt}\r\n> "));
        }
        true
    }
}

fn say(text: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

fn stty(mode: &[&str]) {
    let _ = Command::new("stty").args(mode).status();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let resume = value("--resume");
    let Some(id) = resume.clone().or_else(|| value("--session-id")) else {
        eprintln!("fake claude: --session-id or --resume is required");
        std::process::exit(2);
    };
    let cwd = std::env::current_dir().and_then(std::fs::canonicalize).unwrap_or_default();
    let mut pane = Pane {
        id,
        settings: value("--settings").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
        home: PathBuf::from(std::env::var_os("HOME").unwrap_or_default()),
        cwd: cwd.to_string_lossy().into_owned(),
        entries: 0,
        last: None,
    };
    if resume.is_some() && !pane.transcript().exists() {
        eprintln!("No conversation found with session ID: {}", pane.id);
        std::process::exit(1);
    }

    stty(&["raw", "-echo"]);
    pane.session_started();
    say("\x1b]0;\u{2733} Fake Claude\x07fake claude ready\r\n> ");

    let mut keys = std::io::BufReader::new(std::io::stdin()).bytes().map_while(Result::ok);
    let mut composer: Vec<u8> = Vec::new();
    let mut sequence: Vec<u8> = Vec::new();
    while let Some(key) = keys.next() {
        // Escape sequences (the paste brackets) are swallowed whole.
        if key == 0x1b || !sequence.is_empty() {
            sequence.push(key);
            if sequence.len() > 1 && (key.is_ascii_alphabetic() || key == b'~') {
                sequence.clear();
            }
            continue;
        }
        match key {
            b'\r' => {
                let prompt = String::from_utf8_lossy(&composer).into_owned();
                composer.clear();
                if !prompt.trim().is_empty() && !pane.submit(&prompt, &mut keys) {
                    break;
                }
            }
            // Ctrl-C, Ctrl-D.
            3 | 4 => break,
            // Backspace.
            8 | 0x7f => {
                composer.pop();
            }
            _ => composer.push(key),
        }
    }
    stty(&["sane"]);
}
