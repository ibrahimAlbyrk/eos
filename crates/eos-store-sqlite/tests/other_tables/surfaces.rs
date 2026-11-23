//! The surface tables: rows read back as written, lists filtered and in
//! order, version and issue numbers counted on, issues paged newest first,
//! and an action record's client id held once.

use eos_contracts::ActionClass;
use eos_core::Error;
use eos_core::store::{StoredActionRecord, StoredIssue, StoredSurface, StoredSurfaceState, StoredSurfaceVersion};
use eos_surface::{IssueKind, IssueStatus, Level, MadeBy, Place, Role, VersionStatus};
use eos_testkit::TempStore;

fn surface(id: &str, routine: &str, place: Place, created_at: i64) -> StoredSurface {
    StoredSurface {
        id: id.into(),
        routine_id: routine.into(),
        level: Level::View,
        place,
        role: Role::Result,
        title: "Overnight mail".into(),
        current_version: None,
        candidate_version: None,
        needs_redesign_json: None,
        archived_at: None,
        created_at,
        updated_at: created_at,
    }
}

fn issue(id: &str, created_at: i64, seq: Option<i64>) -> StoredIssue {
    StoredIssue {
        id: id.into(),
        surface_id: "sf-a".into(),
        seq,
        run_id: Some("rn-1".into()),
        version: None,
        kind: IssueKind::View,
        status: IssueStatus::Ready,
        body_json: r#"{"view":{"title":"Digest"}}"#.into(),
        rev: 1,
        images_json: "[]".into(),
        trial: seq.is_none(),
        kept: false,
        created_at,
        updated_at: created_at,
    }
}

fn record(id: &str, client: &str) -> StoredActionRecord {
    StoredActionRecord {
        id: id.into(),
        client_id: Some(client.into()),
        action_id: "routine.run_again".into(),
        surface_id: Some("sf-a".into()),
        issue_id: Some("si-1".into()),
        routine_id: Some("rt-1".into()),
        origin: "dashboard".into(),
        class: ActionClass::WriteLocal,
        args_json: "{}".into(),
        decision: "run".into(),
        status: "running".into(),
        result_json: None,
        error_kind: None,
        created_at: 50,
        finished_at: None,
    }
}

#[test]
fn surfaces_list_by_routine_and_place_without_the_archived() {
    let temp = TempStore::new();
    let mut archived = surface("sf-c", "rt-1", Place::NeedsYou, 3);
    archived.archived_at = Some(9);
    let (all, needs, of_routine, found) = temp
        .store
        .write_blocking({
            let archived = archived.clone();
            move |tx, _| {
                let s = tx.surfaces();
                s.put(&surface("sf-b", "rt-1", Place::RoutinePage, 2))?;
                s.put(&surface("sf-a", "rt-1", Place::NeedsYou, 1))?;
                s.put(&surface("sf-d", "rt-2", Place::NeedsYou, 4))?;
                s.put(&archived)?;
                let ids = |rows: Vec<StoredSurface>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
                Ok((
                    ids(s.list(None, None)?),
                    ids(s.list(Some("rt-1"), Some(Place::NeedsYou))?),
                    ids(s.of_routine("rt-1")?),
                    s.find("sf-c")?,
                ))
            }
        })
        .expect("writes");
    assert_eq!(all, ["sf-a", "sf-b", "sf-d"]);
    assert_eq!(needs, ["sf-a"]);
    assert_eq!(of_routine, ["sf-a", "sf-b", "sf-c"]);
    assert_eq!(found, Some(archived));
}

#[test]
fn versions_count_on_and_read_newest_first() {
    let temp = TempStore::new();
    let v = |version, status| StoredSurfaceVersion {
        surface_id: "sf-a".into(),
        version,
        status,
        base_version: None,
        made_by: MadeBy::Designer,
        run_id: None,
        note: "first".into(),
        body_json: "{}".into(),
        body_bytes: 2,
        checks_json: "{}".into(),
        created_at: version,
        kept_at: None,
    };
    let (first, listed, next) = temp
        .store
        .write_blocking(move |tx, _| {
            let vs = tx.surface_versions();
            let first = vs.next_number("sf-a")?;
            vs.put(&v(1, VersionStatus::Candidate))?;
            vs.put(&v(1, VersionStatus::Kept))?;
            vs.put(&v(2, VersionStatus::Checking))?;
            let listed: Vec<_> = vs.of_surface("sf-a")?.into_iter().map(|r| (r.version, r.status)).collect();
            Ok((first, listed, vs.next_number("sf-a")?))
        })
        .expect("writes");
    assert_eq!(first, 1);
    assert_eq!(listed, [(2, VersionStatus::Checking), (1, VersionStatus::Kept)]);
    assert_eq!(next, 3);
}

#[test]
fn issues_page_newest_first_and_count_their_numbers() {
    let temp = TempStore::new();
    let (newest, older, seq, of_run, gone, found) = temp
        .store
        .write_blocking(move |tx, _| {
            let is = tx.surface_issues();
            is.put(&issue("si-1", 10, Some(1)))?;
            is.put(&issue("si-2", 20, Some(2)))?;
            is.put(&issue("si-3", 20, None))?;
            is.put(&issue("si-4", 30, Some(3)))?;
            let ids = |rows: Vec<StoredIssue>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
            let newest = ids(is.of_surface("sf-a", None, 2)?);
            let older = ids(is.of_surface("sf-a", Some("si-3"), 5)?);
            let seq = is.next_seq("sf-a")?;
            let of_run = ids(is.of_run("rn-1")?);
            let gone = is.delete(&["si-1".into(), "si-9".into()])?;
            Ok((newest, older, seq, of_run, gone, is.find("si-4")?))
        })
        .expect("writes");
    assert_eq!(newest, ["si-4", "si-3"]);
    assert_eq!(older, ["si-2", "si-1"], "issues made before the one named, ties broken by id");
    assert_eq!(seq, 4);
    assert_eq!(of_run, ["si-1", "si-2", "si-3", "si-4"]);
    assert_eq!(gone, 1);
    assert_eq!(found, Some(issue("si-4", 30, Some(3))));
}

#[test]
fn state_reads_back_per_scope() {
    let temp = TempStore::new();
    let state = |scope: &str, data: &str| StoredSurfaceState {
        surface_id: "sf-a".into(),
        scope: scope.into(),
        data_json: data.into(),
        bytes: data.len() as i64,
        updated_at: 5,
    };
    let (whole, one, none) = temp
        .store
        .write_blocking(move |tx, _| {
            let st = tx.surface_state();
            st.put(&state("", r#"{"a":1}"#))?;
            st.put(&state("", r#"{"a":2}"#))?;
            st.put(&state("si-1", r#"{"note":"x"}"#))?;
            Ok((st.find("sf-a", "")?, st.find("sf-a", "si-1")?, st.find("sf-a", "si-2")?))
        })
        .expect("writes");
    assert_eq!(whole, Some(state("", r#"{"a":2}"#)));
    assert_eq!(one, Some(state("si-1", r#"{"note":"x"}"#)));
    assert_eq!(none, None);
}

#[test]
fn an_action_record_holds_its_client_id_once_and_updates_in_place() {
    let temp = TempStore::new();
    let mut done = record("da-1", "c-1");
    done.status = "done".into();
    done.finished_at = Some(60);
    let (again, by_client, count) = temp
        .store
        .write_blocking({
            let done = done.clone();
            move |tx, _| {
                let log = tx.action_log();
                log.insert(&record("da-1", "c-1"))?;
                let again = log.insert(&record("da-2", "c-1"));
                log.update(&done)?;
                log.insert(&record("da-3", "c-3"))?;
                Ok((again, log.by_client("c-1")?, log.count_since("sf-a", 50)?))
            }
        })
        .expect("writes");
    assert!(matches!(again, Err(Error::Conflict(_))));
    assert_eq!(by_client, Some(done));
    assert_eq!(count, 2);
}
