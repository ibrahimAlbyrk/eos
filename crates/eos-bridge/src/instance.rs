//! One running app per data folder. The first launch listens on a socket there; a later
//! launch hands its request (show the window, open a link, quit, report status) to the first
//! and exits. The socket's file mode is the gate: only this user can reach it.

use std::io::{BufRead, BufReader, Read as _, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

/// What a launch asks of the running app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Show the window and bring the app forward.
    Activate,
    /// Open a link the system handed over (`eos://pair/…`).
    Open(String),
    /// Quit, stopping everything.
    Quit,
    /// Report the shell's state as JSON.
    Status,
}

impl Request {
    /// Reads a launch's arguments (without the program name). A link wins over the flags;
    /// anything unknown is ignored (the system adds arguments of its own).
    pub fn from_args<S: AsRef<str>>(args: &[S]) -> Self {
        if let Some(url) = args.iter().map(AsRef::as_ref).find(|a| a.starts_with("eos://")) {
            return Request::Open(url.to_string());
        }
        if args.iter().any(|a| a.as_ref() == "--quit") {
            Request::Quit
        } else if args.iter().any(|a| a.as_ref() == "--status") {
            Request::Status
        } else {
            Request::Activate
        }
    }

    /// Whether this launch only talks to a running app and never becomes the app itself.
    pub fn is_control(&self) -> bool {
        matches!(self, Request::Quit | Request::Status)
    }

    fn to_line(&self) -> String {
        let value = match self {
            Request::Activate => json!({ "cmd": "activate" }),
            Request::Open(url) => json!({ "cmd": "open", "url": url }),
            Request::Quit => json!({ "cmd": "quit" }),
            Request::Status => json!({ "cmd": "status" }),
        };
        format!("{value}\n")
    }

    fn from_line(line: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(line.trim()).ok()?;
        match value.get("cmd")?.as_str()? {
            "activate" => Some(Request::Activate),
            "open" => Some(Request::Open(value.get("url")?.as_str()?.to_string())),
            "quit" => Some(Request::Quit),
            "status" => Some(Request::Status),
            _ => None,
        }
    }
}

/// The first launch's end of the socket.
#[derive(Debug)]
pub struct Instance {
    listener: UnixListener,
    path: PathBuf,
}

/// What a launch found.
#[derive(Debug)]
pub enum Acquired {
    /// No app is running for this data folder: this launch is it.
    First(Instance),
    /// An app is running: talk to it with [`ask`].
    Running(UnixStream),
}

/// Connects to the running app, if there is one. For a launch that only wants to talk
/// (`--quit`, `--status`): it must never take the socket itself, or a real launch racing
/// with it would find a "running app" that answers nothing.
pub fn connect(socket: &Path) -> Option<UnixStream> {
    UnixStream::connect(socket).ok()
}

/// Becomes the app for `socket`'s folder, or connects to the one that is.
pub fn acquire(socket: &Path) -> std::io::Result<Acquired> {
    if let Some(dir) = socket.parent() {
        std::fs::create_dir_all(dir)?;
    }
    for _ in 0..2 {
        match UnixListener::bind(socket) {
            Ok(listener) => {
                std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
                return Ok(Acquired::First(Instance { listener, path: socket.to_path_buf() }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => match UnixStream::connect(socket) {
                Ok(stream) => return Ok(Acquired::Running(stream)),
                // Nobody listens: the file is left over from an app that died.
                Err(_) => std::fs::remove_file(socket)?,
            },
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "the instance socket is contested"))
}

/// Sends one request to the running app and returns its one-line answer.
pub fn ask(mut stream: UnixStream, request: &Request) -> std::io::Result<String> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    stream.write_all(request.to_line().as_bytes())?;
    let mut answer = String::new();
    BufReader::new(stream).read_line(&mut answer)?;
    Ok(answer.trim().to_string())
}

impl Instance {
    /// Serves later launches on a thread of its own for as long as the process lives.
    /// `handle` returns the one-line answer; it must not block for long.
    pub fn serve(self, handle: impl Fn(Request) -> String + Send + 'static) {
        std::thread::spawn(move || {
            for stream in self.listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                // One short line; a peer that sends more is not one of ours.
                let read = BufReader::new(&stream).take(8192).read_line(&mut line);
                let answer = match read.ok().and_then(|_| Request::from_line(&line)) {
                    Some(request) => handle(request),
                    None => r#"{"error":"bad request"}"#.to_string(),
                };
                let mut stream = stream;
                let _ = stream.write_all(format!("{}\n", answer.replace('\n', " ")).as_bytes());
            }
        });
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir;

    #[test]
    fn arguments_become_requests() {
        assert_eq!(Request::from_args::<&str>(&[]), Request::Activate);
        assert_eq!(Request::from_args(&["-psn_0_12345"]), Request::Activate);
        assert_eq!(Request::from_args(&["--quit"]), Request::Quit);
        assert_eq!(Request::from_args(&["--status"]), Request::Status);
        assert_eq!(Request::from_args(&["--quit", "eos://pair/abc"]), Request::Open("eos://pair/abc".into()));
        assert_eq!(Request::from_args(&["https://example.com"]), Request::Activate, "only the app's own scheme");
        assert!(Request::Quit.is_control() && Request::Status.is_control());
        assert!(!Request::Activate.is_control() && !Request::Open(String::new()).is_control());
    }

    #[test]
    fn requests_survive_the_wire() {
        for request in [Request::Activate, Request::Open("eos://pair/a b\n\"c".into()), Request::Quit, Request::Status]
        {
            let line = request.to_line();
            assert_eq!(line.matches('\n').count(), 1, "one line: {line:?}");
            assert_eq!(Request::from_line(&line), Some(request));
        }
        assert_eq!(Request::from_line("{\"cmd\":\"explode\"}"), None);
        assert_eq!(Request::from_line("not json"), None);
    }

    #[test]
    fn the_second_launch_reaches_the_first() {
        let dir = Dir::new("instance");
        let socket = dir.path().join("shell.sock");
        let Acquired::First(first) = acquire(&socket).unwrap() else { panic!("the first launch must win") };
        assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);
        first.serve(|request| match request {
            Request::Open(url) => format!("{{\"opened\":\"{url}\"}}"),
            other => format!("{{\"got\":\"{other:?}\"}}"),
        });
        for (request, answer) in [
            (Request::Open("eos://pair/x".into()), "{\"opened\":\"eos://pair/x\"}"),
            (Request::Quit, "{\"got\":\"Quit\"}"),
            (Request::Status, "{\"got\":\"Status\"}"),
        ] {
            let Acquired::Running(stream) = acquire(&socket).unwrap() else { panic!("an app is running") };
            assert_eq!(ask(stream, &request).unwrap(), answer);
        }
    }

    #[test]
    fn a_control_launch_never_takes_the_socket() {
        let dir = Dir::new("instance-control");
        let socket = dir.path().join("shell.sock");
        assert!(connect(&socket).is_none(), "no app, no socket");
        assert!(!socket.exists());
        let Acquired::First(first) = acquire(&socket).unwrap() else { panic!() };
        first.serve(|_| "{\"up\":true}".to_string());
        assert_eq!(ask(connect(&socket).unwrap(), &Request::Status).unwrap(), "{\"up\":true}");
    }

    #[test]
    fn a_socket_left_by_a_dead_app_is_taken_over() {
        let dir = Dir::new("instance-stale");
        let socket = dir.path().join("shell.sock");
        drop(UnixListener::bind(&socket).unwrap());
        assert!(socket.exists(), "the file outlives its listener");
        assert!(matches!(acquire(&socket).unwrap(), Acquired::First(_)));
    }

    #[test]
    fn a_stranger_on_the_socket_gets_an_error_line() {
        let dir = Dir::new("instance-bad");
        let socket = dir.path().join("shell.sock");
        let Acquired::First(first) = acquire(&socket).unwrap() else { panic!() };
        first.serve(|_| "{}".to_string());
        let mut stream = UnixStream::connect(&socket).unwrap();
        stream.write_all(b"GET / HTTP/1.1\n").unwrap();
        let mut answer = String::new();
        BufReader::new(stream).read_line(&mut answer).unwrap();
        assert_eq!(answer.trim(), r#"{"error":"bad request"}"#);
    }
}
