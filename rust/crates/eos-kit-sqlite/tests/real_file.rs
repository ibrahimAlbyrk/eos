//! Opening a file today's app wrote. Runs only when `EOS_TEST_STATE_DB` names
//! one; the test works on its own copy and prints nothing from it.

use std::path::PathBuf;
use std::time::Instant;

use eos_kit_sqlite::{Db, EMBEDDED, Error, Options, database_files, preflight};

#[test]
fn a_database_written_by_the_typescript_app_is_up_to_date() {
    let Some(source) = std::env::var_os("EOS_TEST_STATE_DB").map(PathBuf::from) else {
        eprintln!("EOS_TEST_STATE_DB not set: skipped");
        return;
    };
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("state.db");
    for (from, to) in database_files(&source).iter().zip(database_files(&path)) {
        if from.exists() {
            std::fs::copy(from, to).expect("copy");
        }
    }

    let before = preflight(&path, EMBEDDED).expect("preflight");
    assert!(before.up_to_date(), "pending: {:?}", before.pending);

    let started = Instant::now();
    let (db, report) = Db::open(&path, Options::default(), 1).expect("open");
    let workers: i64 =
        db.read(|c| Ok::<_, Error>(c.query_row("SELECT count(*) FROM workers", [], |r| r.get(0))?)).expect("read");
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(report.up_to_date(), "applied: {:?}, adopted: {:?}", report.applied, report.adopted);
    assert_eq!(report.unknown, before.unknown);
    assert!(workers > 0);
    eprintln!(
        "up to date; {} recorded ids unknown to this build; open + migration check + first read: {open_ms:.1} ms",
        report.unknown.len()
    );
}
