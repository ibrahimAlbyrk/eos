//! What signals log (02 §3 I.46): ids, kinds, decisions and counts, never
//! a signal's key, subject, scope or facts.

use std::io::Write;
use std::sync::{Arc, Mutex};

use eos_contracts::{Fact, RoutineState};
use eos_mod_signals::SoloRunner;
use eos_runtime::module::Module;
use tracing_subscriber::fmt::MakeWriter;

use crate::rig::{Bench, SOURCE_ID, SavedIntake, page, pull, routine};

/// The planted text: a subject and a sender's address.
const SECRET_TITLE: &str = "Payroll-2026 sk-live-4fd9";
const SECRET_FROM: &str = "ceo.private@example.org";
const SECRET_REPO: &str = "acme-secret/vault";

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("not poisoned").extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Captured {
    type Writer = Captured;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

// The store logs from its own threads: the subscriber is the program's
// one, and the other tests' lines plant none of these texts.
#[tokio::test(flavor = "multi_thread")]
async fn a_signals_key_subject_scope_and_facts_never_reach_the_log() {
    let captured = Captured::default();
    let subscriber =
        tracing_subscriber::fmt().with_writer(captured.clone()).with_max_level(tracing::Level::TRACE).finish();
    tracing::subscriber::set_global_default(subscriber).expect("the program's only subscriber");

    let mut bench = Bench::new(vec![
        routine("rt-1", RoutineState::Active, &["opened"], None),
        routine("rt-2", RoutineState::Paused, &["opened"], None),
    ]);
    bench.runner = Arc::new(SoloRunner::new("dev-1"));
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    let mut planted = pull(7, "c0ffee", "opened", false, &["payroll/salaries.csv"]);
    planted.key = format!("github:pr:{SECRET_REPO}#7@c0ffee");
    planted.subject = format!("github:pr:{SECRET_REPO}#7");
    planted.facts.insert("title".into(), Fact::Text(SECRET_TITLE.into()));
    planted.facts.insert("from".into(), Fact::Text(SECRET_FROM.into()));
    module.ingest(SOURCE_ID, page(vec![planted], serde_json::json!({"etag": "e1"}))).await.expect("kept");
    bench.route(&module).await;
    assert_eq!(bench.admitted(), [("rt-1".to_owned(), 1)]);
    module.stop().await;

    let log = String::from_utf8(captured.0.lock().expect("not poisoned").clone()).expect("text");
    assert!(log.contains("a signal was decided") && log.contains("routine_id=rt-1"), "told by id:\n{log}");
    for secret in [SECRET_TITLE, SECRET_FROM, SECRET_REPO, "salaries.csv", "c0ffee"] {
        assert!(!log.contains(secret), "{secret} reached the log:\n{log}");
    }
}
