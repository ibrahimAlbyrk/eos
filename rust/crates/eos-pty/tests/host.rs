//! Real shells in real PTYs: `/bin/sh` with an empty environment and its
//! home in a temporary folder, so nothing of the user's profile runs.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use eos_core::terminal::{Pty, PtyEvents, PtySpawn, Terminals};
use eos_platform::{PosixShell, process_alive};
use eos_pty::PtyTerminals;

static SHELL: LazyLock<PosixShell> = LazyLock::new(|| PosixShell::fixed("/bin/sh"));

enum Got {
    Output(String),
    Exit(i32),
}

struct Sink {
    tx: Sender<Got>,
    /// Blocks every delivery for this long: a slow consumer.
    slow: Duration,
}

impl PtyEvents for Sink {
    fn output(&mut self, text: &str) {
        std::thread::sleep(self.slow);
        let _ = self.tx.send(Got::Output(text.to_owned()));
    }

    fn exit(&mut self, code: i32) {
        let _ = self.tx.send(Got::Exit(code));
    }
}

struct Session {
    pty: Option<Arc<dyn Pty>>,
    rx: Receiver<Got>,
    seen: String,
    _home: tempfile::TempDir,
}

const WAIT: Duration = Duration::from_secs(20);

impl Session {
    fn start(command: Option<&str>, slow: Duration) -> Self {
        let home = tempfile::tempdir().expect("a folder");
        let (tx, rx) = channel();
        let spec = PtySpawn {
            cwd: home.path().to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            command: command.map(str::to_owned),
            env: Some(vec![
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), home.path().to_string_lossy().into_owned()),
            ]),
        };
        let pty = PtyTerminals::new(&*SHELL).spawn(spec, Box::new(Sink { tx, slow })).expect("a terminal");
        Self { pty: Some(pty), rx, seen: String::new(), _home: home }
    }

    fn pty(&self) -> &Arc<dyn Pty> {
        self.pty.as_ref().expect("the terminal")
    }

    /// Reads output until `needle` shows up; what was read stays in `seen`.
    fn until(&mut self, needle: &str) {
        let deadline = Instant::now() + WAIT;
        while !self.seen.contains(needle) {
            let left = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("no {needle:?} in {:?}", self.seen));
            match self.rx.recv_timeout(left) {
                Ok(Got::Output(text)) => self.seen.push_str(&text),
                Ok(Got::Exit(code)) => panic!("the shell ended ({code}) before {needle:?}: {:?}", self.seen),
                Err(_) => panic!("no {needle:?} in {:?}", self.seen),
            }
        }
    }

    fn exit_code(&mut self) -> i32 {
        loop {
            match self.rx.recv_timeout(WAIT) {
                Ok(Got::Output(text)) => self.seen.push_str(&text),
                Ok(Got::Exit(code)) => return code,
                Err(_) => panic!("the shell did not end: {:?}", self.seen),
            }
        }
    }

    /// The shell's process id, asked of the shell itself. The terminal echoes
    /// the question too; only the answer has digits between the marks.
    fn shell_pid(&mut self) -> u32 {
        self.pty().write(b"echo pid=$$=\r");
        let deadline = Instant::now() + WAIT;
        loop {
            let answer = self.seen.split("pid=").filter_map(|rest| rest.split('=').next()?.parse().ok()).last();
            if let Some(pid) = answer {
                return pid;
            }
            assert!(Instant::now() < deadline, "no pid in {:?}", self.seen);
            if let Ok(Got::Output(text)) = self.rx.recv_timeout(Duration::from_millis(50)) {
                self.seen.push_str(&text);
            }
        }
    }
}

fn gone_within(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_alive(pid) {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

#[test]
fn a_shell_runs_takes_input_and_reports_its_exit_code() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    s.pty().write(b"echo one-$((40+2))\r");
    s.until("one-42");
    s.pty().write(b"exit 7\r");
    assert_eq!(s.exit_code(), 7);
}

#[test]
fn a_first_command_runs_and_the_shell_stays_open() {
    let mut s = Session::start(Some("echo pty-ready"), Duration::ZERO);
    s.until("pty-ready");
    s.until("$ ");
    s.pty().write(b"echo still-$((1+1))\r");
    s.until("still-2");
}

#[test]
fn a_resize_reaches_the_program() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    s.pty().write(b"stty size\r");
    s.until("24 80");
    s.pty().resize(100, 30);
    s.pty().write(b"stty size\r");
    s.until("30 100");
}

#[test]
fn the_terminal_has_its_identity() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    s.pty().write(b"echo $TERM/$TERM_PROGRAM/$COLORTERM\r");
    s.until("xterm-256color/eos/truecolor");
}

#[test]
fn a_kill_hangs_the_shell_up_and_leaves_nothing_behind() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    let pid = s.shell_pid();
    assert!(process_alive(pid));
    s.pty().kill();
    // A hang-up is a signal: node-pty reported exit code 0 for it.
    assert_eq!(s.exit_code(), 0);
    assert!(gone_within(pid, Duration::from_secs(5)), "the shell is gone");
}

#[test]
fn dropping_the_terminal_ends_the_shell() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    let pid = s.shell_pid();
    s.pty = None;
    assert!(gone_within(pid, Duration::from_secs(5)), "no shell without its terminal");
}

#[test]
fn a_shell_that_ignores_the_hang_up_is_killed() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    let pid = s.shell_pid();
    s.pty().write(b"trap '' HUP; echo armed\r");
    s.until("armed\r\n");
    s.pty = None;
    assert!(gone_within(pid, Duration::from_secs(8)), "killed after the grace");
}

#[test]
fn the_foreground_program_is_named() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    // `/bin/sh` is another shell under that name on some systems.
    let shell = s.pty().foreground().expect("a foreground program");
    assert!(["sh", "bash", "dash", "zsh"].contains(&shell.as_str()), "{shell}");
    s.pty().write(b"sleep 30\r");
    let deadline = Instant::now() + WAIT;
    while s.pty().foreground().as_deref() != Some("sleep") {
        assert!(Instant::now() < deadline, "sleep never came to the foreground");
        std::thread::sleep(Duration::from_millis(20));
    }
    s.pty().write(b"\x03");
    s.until("^C");
}

#[test]
fn a_slow_consumer_holds_the_program_back_and_loses_nothing() {
    // 2 MB through a consumer that takes a millisecond per piece: every byte
    // arrives, in order, and the end comes after the last of them.
    let mut s = Session::start(None, Duration::from_millis(1));
    s.until("$ ");
    s.pty().write(b"stty -echo; i=0; while [ $i -lt 20000 ]; do echo \"line-$i-................................................................................\"; i=$((i+1)); done; echo END-OF-FLOOD; exit 3\r");
    assert_eq!(s.exit_code(), 3);
    let lines: Vec<&str> = s.seen.lines().filter(|l| l.starts_with("line-")).collect();
    assert_eq!(lines.len(), 20000);
    for (i, line) in lines.iter().enumerate() {
        assert!(line.starts_with(&format!("line-{i}-")), "line {i} out of order: {line}");
    }
    assert!(s.seen.contains("END-OF-FLOOD"));
}

#[test]
fn text_cut_by_a_read_arrives_whole() {
    let mut s = Session::start(None, Duration::ZERO);
    s.until("$ ");
    // "ç漢😀" as octal escapes: the bytes are the shell's, whatever its locale.
    s.pty().write(b"stty -echo; i=0; while [ $i -lt 3000 ]; do printf '\\303\\247\\346\\274\\242\\360\\237\\230\\200'; i=$((i+1)); done; echo; echo DONE\r");
    s.until("DONE");
    assert!(!s.seen.contains('\u{FFFD}'), "no character was cut");
    assert_eq!(s.seen.matches("ç漢😀").count(), 3000);
}
