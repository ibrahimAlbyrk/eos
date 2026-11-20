//! Edits of routines' drafts: each new edit is a moment once, the rules keep
//! what the user changed as a note for the routine, and an edit of a draft
//! made from outside text never teaches the outside text.

use std::sync::Arc;

use eos_contracts::{EditOp, Part, PartEdit, ResultDoc};
use eos_core::BoxFuture;
use eos_core::inbox::{ResultEdit, ResultEdits};
use eos_core::profile::{KeepResult, StatedRule, UserMemoryKeeper};
use eos_core::store::{NoteQuery, StoredMoment};
use eos_domain::redact::Scrubber;
use eos_memory::edits::{capture, describe, edit_of, edit_rows};
use eos_memory::merge::Place;
use eos_memory::{Gate, ModelGate, MomentContext, MomentSource, Recall, ReflectParts, ReflectPrompt, Reflector};
use eos_testkit::{FakeClock, FakeResultEdits, FakeTimeZone, ScriptedOneShot, SeqIds, TempStore};

const SUMMARY: &str = "This pull request changes the build so that every module is compiled twice and the cache \
    is warmed before tests run, which takes longer but catches stale artifacts early in CI.";

fn part(key: &str, role: &str, text: &str) -> Part {
    Part { key: key.into(), role: role.into(), text: text.into(), meta: Default::default() }
}

fn edit(id: i64, untrusted: bool) -> ResultEdit {
    edit_to(id, untrusted, "Compiles every module twice and warms the cache first.")
}

fn edit_to(id: i64, untrusted: bool, short: &str) -> ResultEdit {
    let before = ResultDoc {
        kind: "github.review".into(),
        channel: "github".into(),
        action: "post_review".into(),
        parts: vec![part("summary", "summary", SUMMARY), part("c:1", "comment", "Nit: rename this variable.")],
    };
    let after = ResultDoc { parts: vec![part("summary", "summary", short)], ..before.clone() };
    let ops = vec![
        PartEdit {
            key: "summary".into(),
            op: EditOp::Changed,
            before: Some(before.parts[0].clone()),
            after: Some(after.parts[0].clone()),
        },
        PartEdit { key: "c:1".into(), op: EditOp::Removed, before: Some(before.parts[1].clone()), after: None },
    ];
    ResultEdit {
        id,
        item_id: "nd-1".into(),
        delivery_id: None,
        routine_id: "rt-1".into(),
        run_id: "rn-1".into(),
        before,
        after,
        ops,
        derived_from_untrusted: untrusted,
        at: 10,
    }
}

#[test]
fn an_edit_is_told_in_the_user_s_changes_and_outside_text_stays_out() {
    let trusted = describe(&edit(1, false));
    assert!(trusted.contains("(shortened from 31 to 9 words)"), "{trusted}");
    assert!(trusted.contains("removed the comment \"Nit: rename this variable.\""), "{trusted}");
    let untrusted = describe(&edit(1, true));
    assert!(!untrusted.contains("Nit:") && !untrusted.contains("compiled twice"), "{untrusted}");
    assert!(untrusted.contains("removed a comment"));
    let rows = edit_rows(&edit(5, true));
    assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3, 4, 5]);
    assert_eq!(edit_of("edit:5"), Some(5));
}

#[tokio::test]
async fn each_new_edit_is_a_moment_once() {
    let temp = TempStore::new();
    let edits = FakeResultEdits::new();
    edits.add(edit(1, false));
    edits.add(edit(2, false));
    let (store, clock, ids) = (temp.port(), FakeClock::new(), SeqIds::new());
    assert_eq!(capture(&store, &clock, &ids, &edits).await.unwrap(), 2);
    assert_eq!(capture(&store, &clock, &ids, &edits).await.unwrap(), 0);
    assert_eq!(temp.count("SELECT COUNT(*) FROM mem_moments WHERE source = 'edit' AND signal = 'edits'"), 2);
    temp.exec("INSERT OR REPLACE INTO mem_settings (key, value) VALUES ('learning', 'off')");
    edits.add(edit(3, false));
    assert_eq!(capture(&store, &clock, &ids, &edits).await.unwrap(), 0, "Learning off");
}

struct EditSource(Arc<FakeResultEdits>);

impl MomentSource for EditSource {
    fn context<'a>(
        &'a self,
        moment: &'a StoredMoment,
    ) -> BoxFuture<'a, Result<Option<MomentContext>, eos_core::Error>> {
        Box::pin(async move {
            let Some(edit) = self.0.get(edit_of(&moment.worker_id).unwrap()).await? else { return Ok(None) };
            Ok(Some(MomentContext {
                rows: edit_rows(&edit),
                anthropic: true,
                untrusted: edit.derived_from_untrusted,
                place: Place { routine: Some(edit.routine_id.clone()), project: None },
                project_path: None,
            }))
        })
    }
}

struct RulesOnly;

impl ModelGate for RulesOnly {
    fn gate(&self) -> BoxFuture<'_, Gate> {
        Box::pin(std::future::ready(Gate::RulesOnly))
    }
}

struct NoPrompt;

impl ReflectPrompt for NoPrompt {
    fn render(&self, _: &str, _: &str, _: &str) -> Result<(String, String), eos_core::Error> {
        Ok((String::new(), String::new()))
    }
}

struct NoKeeper;

impl UserMemoryKeeper for NoKeeper {
    fn keep_stated(&self, _: StatedRule) -> Result<KeepResult, eos_core::Error> {
        unreachable!("an edit is not a stated rule")
    }
}

async fn learned_from(edit: ResultEdit) -> (String, String, String) {
    let temp = TempStore::new();
    let edits = Arc::new(FakeResultEdits::new());
    edits.add(edit);
    let clock = Arc::new(FakeClock::new());
    capture(&temp.port(), clock.as_ref(), &SeqIds::new(), edits.as_ref()).await.unwrap();
    let reflector = Reflector::new(ReflectParts {
        store: temp.port(),
        clock: clock.clone(),
        ids: Arc::new(SeqIds::new()),
        zone: Arc::new(FakeTimeZone::new("UTC", 0)),
        one_shot: Arc::new(ScriptedOneShot::default()),
        gate: Arc::new(RulesOnly),
        source: Arc::new(EditSource(edits)),
        prompt: Arc::new(NoPrompt),
        recall: Arc::new(Recall::new(temp.port(), clock)),
        scrubber: Arc::new(Scrubber::new(None)),
        device: "mac-a".into(),
        keeper: Arc::new(NoKeeper),
    });
    assert_eq!(reflector.pass().await.unwrap().learned, 1);
    let notes =
        temp.port().read(|tx| tx.mem_notes().list(&NoteQuery { limit: 5, ..NoteQuery::default() })).await.unwrap();
    let n = &notes[0].note;
    (n.text.clone(), n.trust.as_str().to_owned(), format!("{}:{}", n.scope.level.as_str(), n.scope.key))
}

#[tokio::test]
async fn the_rules_keep_an_edit_for_its_routine_and_an_echo_of_outside_text_is_a_guess() {
    let (text, trust, scope) = learned_from(edit(1, false)).await;
    assert!(text.starts_with("Before sending the github.review draft, I rewrote the summary"), "{text}");
    assert_eq!((trust.as_str(), scope.as_str()), ("did", "routine:rt-1"));
    let (_, trust, _) = learned_from(edit(1, true)).await;
    assert_eq!(trust, "did", "the user's own shorter words do not repeat the draft");
    let copied = "This pull request changes the build so that every module is compiled twice.";
    let (_, trust, _) = learned_from(edit_to(1, true, copied)).await;
    assert_eq!(trust, "guess", "what only repeats the outside draft never teaches");
}
