//! A capability's command under the engine's sandbox, started as Eos starts
//! children: its package, its declared file and its temp folder work;
//! everything else is denied and reported. macOS only, and skipped, saying
//! so, where the sandbox does not work.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_core::capability::{ConfineError, ConfineSpec, Confined, Confinement, Violation};
use eos_domain::capability::manifest::Reach;
use eos_kit_proc::{Command, Env, ProcessTrees, Runner};

use super::Bench;

/// A planted stand-in for a secret, never a real one.
const PLANTED: &str = "PLANTED-NOT-A-SECRET";

/// The tiny package: it tries everything G3 forbids and says what happened.
const SCRIPT: &str = r#"cat readme
cat "$DECLARED"
cat "$PLANTED_FILE" || echo no-planted
echo made > "$DATA/made.txt" && echo data-ok
echo t > "$TMPDIR/t" && cat "$TMPDIR/t" > /dev/null && echo tmp-ok
echo x > "$OUTSIDE" || echo no-outside
/usr/bin/security list-keychains || echo no-security
curl -fsS --max-time 5 --noproxy '' -o /dev/null http://never.invalid/ || echo no-host
curl -fsS --max-time 5 --noproxy '' -o /dev/null "http://127.0.0.1:$PORT/" || echo no-loopback
/usr/bin/env
"#;

/// A temp home holding the package, its data, the call's temp folder, a
/// declared file and a planted one.
struct Home {
    _dir: tempfile::TempDir,
    /// The home as the kernel names it (`/private/var/…`).
    real: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("a folder");
        let real = std::fs::canonicalize(dir.path()).expect("its real path");
        for sub in ["pkg", "data"] {
            std::fs::create_dir_all(real.join(sub)).expect("a folder");
        }
        std::fs::write(real.join("pkg/run.sh"), SCRIPT).expect("the script");
        std::fs::write(real.join("pkg/readme"), "PKG-FILE\n").expect("a package file");
        std::fs::write(real.join("declared.txt"), "DECLARED-FILE\n").expect("a declared file");
        std::fs::write(real.join("planted.txt"), PLANTED).expect("the planted file");
        Self { _dir: dir, real }
    }

    fn at(&self, path: &str) -> PathBuf {
        self.real.join(path)
    }

    fn spec(&self, port: u16) -> ConfineSpec {
        let path = |p: &str| self.at(p).display().to_string();
        ConfineSpec {
            program: "/bin/sh".into(),
            args: vec![path("pkg/run.sh")],
            cwd: self.at("pkg"),
            env: vec![
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("NOTES_TOKEN".into(), "fake-token".into()),
                ("DECLARED".into(), path("declared.txt")),
                ("PLANTED_FILE".into(), path("planted.txt")),
                ("DATA".into(), path("data")),
                ("OUTSIDE".into(), path("outside.txt")),
                ("PORT".into(), port.to_string()),
            ],
            package: self.at("pkg"),
            data: self.at("data"),
            tmpdir: self.at("call"),
            reach: Reach {
                hosts: vec!["declared.invalid".into()],
                apple_events: Vec::new(),
                files_read: vec![path("declared.txt")],
            },
            audit: false,
        }
    }
}

/// A loopback port that counts what reaches it.
async fn listener() -> (u16, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
    let port = listener.local_addr().expect("its address").port();
    let reached = Arc::new(AtomicUsize::new(0));
    let count = reached.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            count.fetch_add(1, Ordering::SeqCst);
            drop(socket);
        }
    });
    (port, reached)
}

/// Starts it as Eos starts a child: its own process tree, exactly the
/// confined environment.
async fn run(confined: &Confined, cwd: &Path) -> String {
    let runner = Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    }));
    let env = confined.env.iter().fold(Env::empty(), |env, (name, value)| env.set(name, value));
    let command = Command::new(&confined.program).args(&confined.args).cwd(cwd).env(env);
    runner.run(command).await.expect("it ran").stdout_text()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_capability_command_reaches_only_what_its_reach_declares() {
    let bench = Bench::new([]).await;
    let home = Home::new();
    let (port, reached) = listener().await;
    let spec = home.spec(port);
    let given: Vec<String> = spec.env.iter().map(|(name, _)| name.clone()).collect();

    let confined = match bench.engine.command(spec).await {
        Err(ConfineError::Unavailable) => {
            eprintln!("skipped: the sandbox does not work on this Mac");
            return;
        }
        other => other.expect("confined"),
    };
    let out = run(&confined, &home.at("pkg")).await;
    let report = confined.guard.finish().await;

    for line in ["PKG-FILE", "DECLARED-FILE", "no-planted", "data-ok", "tmp-ok", "no-outside", "no-security"] {
        assert!(out.contains(line), "{line}: {out}");
    }
    assert!(out.contains("no-host") && out.contains("no-loopback"), "{out}");
    assert!(!out.contains(PLANTED), "the planted file stays unread: {out}");
    assert_eq!(std::fs::read_to_string(home.at("data/made.txt")).expect("made"), "made\n");
    assert!(!home.at("outside.txt").exists());
    assert_eq!(reached.load(Ordering::SeqCst), 0, "nothing reached the loopback listener");

    // Its environment is the spec's with the sandbox's (temp folder, proxy) over it: nothing of Eos's.
    for (name, value) in std::env::vars().filter(|(name, _)| !given.contains(name)) {
        assert!(!confined.env.contains(&(name.clone(), value)), "{name} came from Eos");
    }
    assert!(out.contains("NOTES_TOKEN=fake-token\n") && !out.contains("\nHOME=") && !out.contains("\nUSER="), "{out}");

    assert!(report.watched, "{report:?}");
    let expected = [
        Violation::FileRead { path: home.at("planted.txt") },
        Violation::FileWrite { path: home.at("outside.txt") },
        Violation::Exec { path: "/usr/bin/security".into() },
        Violation::Network { target: "never.invalid:80".into() },
        Violation::Network { target: format!("127.0.0.1:{port}") },
    ];
    for violation in &expected {
        assert!(report.violations.contains(violation), "{violation:?} in {report:?}");
    }
    let readable = [home.at("pkg/readme"), home.at("declared.txt"), home.at("data/made.txt")];
    let wrongly =
        report.violations.iter().find(|v| matches!(v, Violation::FileRead { path } if readable.contains(path)));
    assert_eq!(wrongly, None, "what it may read is not reported");
}
