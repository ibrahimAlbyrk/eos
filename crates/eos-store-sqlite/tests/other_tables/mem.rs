//! Memory's tables: notes read back as written, the search by words follows
//! every write through its triggers, what belongs to a note goes with it,
//! and evidence, done moments, uses and forgotten notes are pruned.

use eos_core::store::{
    DailyCall, MEM_EVIDENCE_PER_NOTE, NoteQuery, StoredCredit, StoredEvidence, StoredForgotten, StoredHook, StoredLink,
    StoredMoment, StoredNoteVersion, StoredUse, StoredVector,
};
use eos_domain::experience::state::Counters;
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust, hook_id};
use eos_testkit::TempStore;

fn note(id: &str, text: &str, updated_at: i64) -> Note {
    Note {
        id: id.into(),
        kind: NoteKind::Lesson,
        text: text.into(),
        body: NoteBody::Lesson { situation: "pushing".into(), wrong: "unlinted".into(), instead: "lint".into() },
        trust: Trust::Did,
        state: NoteState::Trying,
        scope: Scope { level: ScopeLevel::Project, key: "game-client".into() },
        valid_from: 0,
        valid_to: None,
        replaced_by: None,
        do_hooks: vec![hook_id(HookKind::Command, "npm run lint")],
        avoid_hooks: vec![],
        created_at: updated_at,
        updated_at,
        device: "mac-a".into(),
    }
}

fn evidence(id: &str, note_id: &str, at: i64) -> StoredEvidence {
    StoredEvidence {
        id: id.into(),
        note_id: note_id.into(),
        kind: "edits".into(),
        summary: "shortened the summary".into(),
        worker_id: Some("w-1".into()),
        row_from: Some(1),
        row_to: Some(2),
        run_id: None,
        at,
        device: "mac-a".into(),
    }
}

#[test]
fn a_note_reads_back_as_written_and_lists_by_scope_kind_state_and_page() {
    let temp = TempStore::new();
    let first = note("mn-000000000001", "Run npm run lint before pushing.", 10);
    let mut second = note("mn-000000000002", "Assets/Generated is rebuilt from templates.", 20);
    second.scope = Scope::everywhere();
    second.kind = NoteKind::Fact;
    let (found, all, scoped, page, facts) = temp
        .store
        .write_blocking({
            let (first, second) = (first.clone(), second.clone());
            move |tx, _| {
                let notes = tx.mem_notes();
                let rowid = notes.insert(&first, "npm run lint")?;
                assert!(rowid > 0);
                notes.insert(&second, "assets generated")?;
                let all = notes.list(&NoteQuery { limit: 10, ..NoteQuery::default() })?;
                let scoped = notes.list(&NoteQuery {
                    scope: Some((ScopeLevel::Project, Some("game-client".into()))),
                    limit: 10,
                    ..NoteQuery::default()
                })?;
                let page = notes.list(&NoteQuery {
                    before: Some((20, "mn-000000000002".into())),
                    limit: 10,
                    ..NoteQuery::default()
                })?;
                let facts = notes.list(&NoteQuery { kind: Some(NoteKind::Fact), limit: 10, ..NoteQuery::default() })?;
                Ok((notes.find(&first.id)?, all, scoped, page, facts))
            }
        })
        .expect("writes");
    let found = found.expect("found");
    assert_eq!(found.note, first);
    assert_eq!(found.cues, "npm run lint");
    assert_eq!((found.rev, found.forgotten_at, found.counters), (1, None, Counters::default()));
    let ids = |rows: &[eos_core::store::StoredNote]| rows.iter().map(|r| r.note.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&all), ["mn-000000000002", "mn-000000000001"], "newest change first");
    assert_eq!(ids(&scoped), ["mn-000000000001"]);
    assert_eq!(ids(&page), ["mn-000000000001"]);
    assert_eq!(ids(&facts), ["mn-000000000002"]);
}

#[test]
fn the_search_by_words_follows_inserts_updates_deletes_and_forgetting() {
    let temp = TempStore::new();
    let hits = temp
        .store
        .write_blocking(|tx, _| {
            let notes = tx.mem_notes();
            let a = notes.insert(&note("mn-a", "Run the linter before pushing.", 1), "npm run lint")?;
            let b = notes.insert(&note("mn-b", "Türkçe yazılır, şablonlar değişmez.", 2), "sablon")?;
            let mut out = vec![
                notes.search_words("linter", 10)?.iter().map(|h| h.rowid).collect::<Vec<_>>(),
                notes.search_words("lint", 10)?.iter().map(|h| h.rowid).collect(),
                notes.search_words("sablonlar turkce", 10)?.iter().map(|h| h.rowid).collect(),
            ];
            let mut changed = note("mn-a", "Format with prettier first.", 3);
            changed.state = NoteState::Firm;
            notes.update(&changed, "prettier", 2)?;
            out.push(notes.search_words("linter", 10)?.iter().map(|h| h.rowid).collect());
            out.push(notes.search_words("prettier", 10)?.iter().map(|h| h.rowid).collect());
            notes.set_forgotten("mn-a", Some(4))?;
            out.push(notes.search_words("prettier", 10)?.iter().map(|h| h.rowid).collect());
            notes.delete("mn-b")?;
            out.push(notes.search_words("sablon", 10)?.iter().map(|h| h.rowid).collect());
            out.push(notes.search_words("  --  ", 10)?.iter().map(|h| h.rowid).collect());
            assert_eq!(notes.find("mn-a")?.expect("a").rev, 2);
            Ok((out, a, b))
        })
        .expect("writes");
    let (out, a, b) = hits;
    assert_eq!(out[0], vec![a]);
    assert_eq!(out[1], vec![a], "a word matches as a prefix, the cues too");
    assert_eq!(out[2], vec![b], "diacritics folded");
    assert_eq!(out[3], Vec::<i64>::new(), "the old text left the index");
    assert_eq!(out[4], vec![a]);
    assert_eq!(out[5], Vec::<i64>::new(), "forgotten notes are not found");
    assert_eq!(out[6], Vec::<i64>::new(), "a deleted note left the index");
    assert_eq!(out[7], Vec::<i64>::new(), "no words, no search");
}

#[test]
fn what_belongs_to_a_note_goes_with_it() {
    let temp = TempStore::new();
    let left = temp
        .store
        .write_blocking(|tx, _| {
            let rowid = tx.mem_notes().insert(&note("mn-a", "text", 1), "")?;
            tx.mem_notes().insert(&note("mn-b", "other", 1), "")?;
            let hook = StoredHook {
                id: hook_id(HookKind::Path, "Assets"),
                kind: HookKind::Path,
                key: "Assets".into(),
                label: String::new(),
                degree: 0,
            };
            assert!(tx.mem_graph().add_hook(&hook)?);
            assert!(!tx.mem_graph().add_hook(&hook)?, "a hook is written once");
            for (a, b) in [("mn-a", hook.id.as_str()), ("mn-b", hook.id.as_str()), ("mn-b", "mn-a")] {
                tx.mem_graph().put_link(&StoredLink {
                    a: a.into(),
                    b: b.into(),
                    rel: "about".into(),
                    weight: 1.0,
                    co_uses: 0,
                    updated_at: 1,
                })?;
            }
            tx.mem_graph().recount_degrees(std::slice::from_ref(&hook.id))?;
            assert_eq!(tx.mem_graph().hooks(std::slice::from_ref(&hook.id))?[0].degree, 2);
            tx.mem_vectors().put(&StoredVector {
                note_rowid: rowid,
                model: "m".into(),
                scale: 0.5,
                vec: vec![1, -2, 127],
            })?;
            assert_eq!(tx.mem_vectors().all("m")?[0].vec, vec![1, -2, 127]);
            assert_eq!(tx.mem_vectors().missing("m", 10)?, vec![(rowid + 1, "other".to_owned())]);
            tx.mem_versions().insert(&StoredNoteVersion {
                note_id: "mn-a".into(),
                rev: 1,
                text: "text".into(),
                body: "{}".into(),
                scope_level: ScopeLevel::Everywhere,
                scope_key: String::new(),
                state: NoteState::Trying,
                why: "learned".into(),
                at: 1,
            })?;
            tx.mem_evidence().insert(&evidence("me-1", "mn-a", 1))?;
            tx.mem_credit().add("mn-a", "mac-a", 1, 0, 1, Some(5))?;
            tx.mem_notes().delete("mn-a")?;
            Ok((
                tx.mem_graph().links(&["mn-a".into(), "mn-b".into()])?.len(),
                tx.mem_vectors().all("m")?.len(),
                tx.mem_versions().of_note("mn-a")?.len(),
                tx.mem_evidence().of_note("mn-a", 10)?.len(),
                tx.mem_credit().sum("mn-a")?,
            ))
        })
        .expect("writes");
    assert_eq!(left, (1, 0, 0, 0, Counters::default()), "only the link between b and its hook is left");
}

#[test]
fn credit_adds_per_mac_and_sums_over_every_mac() {
    let temp = TempStore::new();
    let (sum, mine, never) = temp
        .store
        .write_blocking(|tx, _| {
            let credit = tx.mem_credit();
            credit.add("mn-a", "mac-a", 1, 0, 1, Some(10))?;
            credit.add("mn-a", "mac-a", 1, 1, 0, None)?;
            credit.put(&StoredCredit {
                note_id: "mn-a".into(),
                device: "mac-b".into(),
                counters: Counters { helped: 2, hurt: 0, used: 3, last_used_at: Some(30) },
            })?;
            credit.add("mn-b", "mac-a", 0, 1, 0, None)?;
            Ok((credit.sum("mn-a")?, credit.of_device("mac-a")?, credit.sum("mn-b")?))
        })
        .expect("writes");
    assert_eq!(sum, Counters { helped: 4, hurt: 1, used: 4, last_used_at: Some(30) });
    assert_eq!(mine[0].counters, Counters { helped: 2, hurt: 1, used: 1, last_used_at: Some(10) });
    assert_eq!(never.last_used_at, None, "never used stays never used");
}

#[test]
fn moments_wait_in_priority_order_and_done_ones_are_pruned() {
    let temp = TempStore::new();
    let moment = |id: &str, trust: Trust, created_at: i64| StoredMoment {
        id: id.into(),
        worker_id: "w-1".into(),
        source: "agent".into(),
        run_id: None,
        signal: "says_wrong".into(),
        trust,
        row_from: 1,
        row_to: 2,
        cues: "[]".into(),
        state: "pending".into(),
        note_id: None,
        attempts: 0,
        created_at,
        done_at: None,
    };
    let (order, attempts, skipped, pruned, left) = temp
        .store
        .write_blocking(move |tx, _| {
            let moments = tx.mem_moments();
            moments.insert(&moment("mm-did", Trust::Did, 1))?;
            moments.insert(&moment("mm-said", Trust::Said, 5))?;
            moments.insert(&moment("mm-outcome", Trust::Outcome, 3))?;
            moments.insert(&moment("mm-old", Trust::Guess, 0))?;
            let order: Vec<String> = moments.pending(10)?.into_iter().map(|m| m.id).collect();
            moments.add_attempt("mm-did")?;
            let attempts = moments.add_attempt("mm-did")?;
            moments.finish("mm-said", "reflected", Some("mn-a"), 10)?;
            let skipped = moments.skip_older(1, 11)?;
            let pruned = moments.prune_done(11)?;
            Ok((order, attempts, skipped, pruned, moments.count_pending()?))
        })
        .expect("writes");
    assert_eq!(order, ["mm-said", "mm-outcome", "mm-did", "mm-old"]);
    assert_eq!((attempts, skipped, pruned, left), (2, 1, 1, 2));
}

#[test]
fn evidence_keeps_the_newest_fifty_and_uses_cursors_forgotten_settings_and_days_keep_their_rows() {
    let temp = TempStore::new();
    temp.store
        .write_blocking(|tx, _| {
            for at in 0..(MEM_EVIDENCE_PER_NOTE + 5) {
                tx.mem_evidence().insert(&evidence(&format!("me-{at:03}"), "mn-a", at))?;
            }
            let kept = tx.mem_evidence().of_note("mn-a", 100)?;
            assert_eq!(kept.len() as i64, MEM_EVIDENCE_PER_NOTE);
            assert_eq!(kept[0].at, MEM_EVIDENCE_PER_NOTE + 4, "newest first");

            tx.mem_cursors().set("w-1", 40, 1)?;
            tx.mem_cursors().set("w-1", 42, 2)?;
            assert_eq!(tx.mem_cursors().get("w-1")?, Some(42));
            tx.mem_cursors().delete("w-1")?;
            assert_eq!(tx.mem_cursors().get("w-1")?, None);

            let uses = tx.mem_uses();
            for (id, at, epoch) in [("me-u1", 10, 0), ("me-u2", 20, 1), ("me-u3", 30, 1)] {
                uses.insert(&StoredUse {
                    id: id.into(),
                    note_id: "mn-a".into(),
                    worker_id: Some("w-1".into()),
                    run_id: (id == "me-u3").then(|| "rn-1".into()),
                    how: "pack".into(),
                    epoch,
                    at,
                    acted: false,
                    outcome: None,
                })?;
            }
            assert_eq!(uses.of_worker("w-1", 1)?.len(), 2);
            assert_eq!(uses.of_run("rn-1")?.len(), 1);
            assert_eq!(uses.times_of_note("mn-a", 2)?, vec![30, 20]);
            uses.set_acted("me-u1")?;
            assert!(uses.of_worker("w-1", 0)?[0].acted);
            assert_eq!(uses.settle(None, Some("rn-1"), "helped")?, 1);
            assert_eq!(uses.settle(Some("w-1"), None, "neutral")?, 2);
            assert_eq!(uses.prune(15)?, 1);

            let book = tx.mem_book();
            book.put_forgotten(&StoredForgotten {
                note_id: "mn-old".into(),
                fingerprint: "{}".into(),
                snapshot: "{}".into(),
                at: 5,
            })?;
            book.put_forgotten(&StoredForgotten {
                note_id: "mn-new".into(),
                fingerprint: "{}".into(),
                snapshot: "{}".into(),
                at: 50,
            })?;
            assert_eq!(book.forgotten_since(10)?.len(), 1);
            assert_eq!(book.prune_forgotten(10)?, vec!["mn-old".to_owned()]);
            assert!(book.forgotten("mn-old")?.is_none());
            book.remove_forgotten("mn-new")?;
            assert!(book.forgotten("mn-new")?.is_none());

            assert_eq!(book.setting("learning")?, None);
            book.set_setting("learning", "false")?;
            assert_eq!(book.setting("learning")?.as_deref(), Some("false"));

            book.count_call("2026-11-20", DailyCall::Reflection)?;
            let day = book.count_call("2026-11-20", DailyCall::Reflection)?;
            assert_eq!((day.reflections, day.classifier, day.night_calls), (2, 0, 0));
            assert_eq!(book.daily("2026-11-21")?.reflections, 0);
            Ok(())
        })
        .expect("writes");
}
