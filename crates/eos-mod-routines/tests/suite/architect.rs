//! Making and changing a routine by talking to its architect: a sentence
//! becomes a listed draft routine with its architect; proposals, a question
//! and its answer, start; a proposal that asks for more freedom; change; the
//! limit of three; leaving a draft; a head made by a newer Eos.

use eos_contracts::{RoutineState, SessionFactsRole, VersionAuthor, VersionStatus, WorkerState};
use eos_core::routine::Proposal;
use eos_core::store::{StoredDraft, StoredVersion};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::run_scope::Trust;
use eos_runtime::access::Caller;
use eos_runtime::http::Method;
use serde_json::{Value, json};

use crate::bench::{blueprint, pull_request};
use crate::run_routes::Routes;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn version_of(payload: &str) -> Value {
    serde_json::from_str::<Value>(payload).expect("json")["versionId"].clone()
}

impl Routes {
    /// Makes a routine from `sentence`; its id and its architect.
    pub(crate) async fn made(&self, sentence: &str) -> (String, String) {
        let (status, saved) = self.post("/api/routines/architect", json!({"sentence": sentence})).await;
        assert_eq!(status, 201, "{saved}");
        let id = saved["row"]["id"].as_str().expect("a row").to_owned();
        (id.clone(), self.draft_row(&id).architect_id.expect("an architect"))
    }

    pub(crate) fn draft_row(&self, routine: &str) -> StoredDraft {
        let id = routine.to_owned();
        self.bench.temp.store.read_blocking(move |tx| tx.routines().draft(&id)).expect("reads").expect("a draft")
    }

    pub(crate) async fn propose(&self, architect: &str, blueprint: Value) -> String {
        let proposal = self.bench.module.architect().propose_blueprint(architect, blueprint, None).await;
        match proposal.expect("proposes") {
            Proposal::Drafted { version_id, .. } => version_id,
            Proposal::Refused(issues) => panic!("refused: {issues:?}"),
        }
    }

    pub(crate) async fn worker_state(&self, worker: &str) -> WorkerState {
        let id = worker.to_owned();
        let row = self.bench.sessions.store().read(move |tx| tx.workers().find(&id)).await.expect("reads");
        row.expect("a worker").state
    }

    pub(crate) fn routine_head(&self, routine: &str) -> Option<String> {
        let id = routine.to_owned();
        let row = self.bench.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads");
        row.and_then(|routine| routine.head_version_id)
    }

    async fn delete(&self, path: &str) -> (u16, Value) {
        self.call(Method::Delete, Caller::DASHBOARD, path, None).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sentence_becomes_a_routine_its_architect_drafts_asks_and_the_user_starts() {
    let routes = Routes::new();
    let (routine, architect) = routes.made("Review my pull requests\nevery morning").await;

    // Listed and read from its first moment, by its placeholder draft.
    let (_, list) = routes.get("/api/routines").await;
    assert_eq!(list[0]["name"], "Review my pull requests");
    assert_eq!(list[0]["state"], "draft");
    let (status, detail) = routes.get(&format!("/api/routines/{routine}")).await;
    assert_eq!((status, &detail["draft"]["status"]), (200, &json!("working")), "{detail}");
    let placeholder = &routes.versions(&routine)[0];
    assert_eq!((placeholder.status, placeholder.author), (VersionStatus::Draft, VersionAuthor::Architect));

    let started = routes.bench.agents.started();
    let spec = started.iter().find(|spec| spec.worker_id == architect).expect("its session");
    assert_eq!(spec.role, SessionFactsRole::Focused);
    assert_eq!(spec.worker_definition.as_deref(), Some("eos-architect"));
    assert_eq!(spec.effort.as_deref(), Some("high"));
    let boot = spec.prompt.clone().expect("a first message");
    assert!(boot.contains("Review my pull requests\nevery morning") && boot.contains("Propose a first blueprint"));
    let id = architect.clone();
    let session = routes.bench.temp.store.read_blocking(move |tx| tx.routine_sessions().find(&id)).expect("reads");
    let session = session.expect("its routine session");
    assert_eq!((session.role.as_str(), session.run_id), ("architect", None));

    // A proposal is a draft version authored by the architect; the routine takes its name.
    let drafted = routes.propose(&architect, blueprint(1)).await;
    let version = routes.versions(&routine).into_iter().find(|v| v.id == drafted).expect("written");
    assert_eq!((version.status, version.author), (VersionStatus::Draft, VersionAuthor::Architect));
    assert_eq!(routes.draft_row(&routine).draft_version_id.as_deref(), Some(drafted.as_str()));
    assert_eq!(routes.get("/api/routines").await.1[0]["name"], "PR Review");
    let tools = routes.bench.module.architect();
    let refused = tools.propose_blueprint(&architect, json!({"format": 1}), None).await.expect("answers");
    assert!(matches!(refused, Proposal::Refused(_)), "{refused:?}");
    assert!(tools.propose_blueprint("w-nobody", blueprint(1), None).await.is_err(), "only its architect");

    // One question; its answer is the user's next message.
    let choices = vec!["acme/game".to_owned(), "acme/web".to_owned()];
    tools.ask_choice(&architect, "Which repository?", &choices).await.expect("asks");
    let (_, draft) = routes.get(&format!("/api/routines/{routine}/draft")).await;
    assert_eq!((&draft["status"], &draft["question"]), (&json!("asking"), &json!("Which repository?")), "{draft}");
    assert_eq!(draft["choices"], json!(choices));
    assert!(draft["changed"].as_array().is_some_and(|slots| slots.contains(&json!("who"))), "no head: every slot");
    let (_, detail) = routes.get(&format!("/api/routines/{routine}")).await;
    assert_eq!(detail["draft"]["question"], "Which repository?", "the detail shows the text alone");
    let (status, answered) =
        routes.post(&format!("/api/routines/{routine}/draft/message"), json!({"choice": "acme/game"})).await;
    assert_eq!((status, &answered["status"]), (200, &json!("working")), "{answered}");
    assert!(answered.get("question").is_none());
    let bench = &routes.bench;
    bench.eventually(|| bench.agents.sent(&architect).iter().any(|text| text.ends_with("\nacme/game"))).await;
    let (status, _) = routes.post(&format!("/api/routines/{routine}/draft/message"), json!({})).await;
    assert_eq!(status, 400, "a text or a choice");

    // Start keeps the draft as the head and suspends the architect.
    let (status, row) = routes.post(&format!("/api/routines/{routine}/start"), json!({"withoutTrial": true})).await;
    assert_eq!((status, &row["state"]), (200, &json!("active")), "{row}");
    let kept = routes.versions(&routine).into_iter().find(|v| v.id == drafted).expect("kept");
    assert_eq!((kept.status, kept.no_trial), (VersionStatus::Kept, true));
    assert_eq!(routes.routine_head(&routine).as_deref(), Some(drafted.as_str()));
    assert_eq!(routes.worker_state(&architect).await, WorkerState::Suspended);
    assert_eq!(routes.draft_row(&routine).status, eos_contracts::DraftStatus::Ready);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_that_asks_for_more_freedom_or_new_places_opens_one_confirm_change_item() {
    let routes = Routes::new();
    let (routine, architect) = routes.made("Review my pull requests").await;
    routes.propose(&architect, blueprint(1)).await;
    let waiting = |routes: &Routes| {
        let items = routes.bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting_with_subject("confirm_change"));
        let items = items.expect("reads").into_iter();
        items
            .filter(|i| i.kind == ItemKind::ConfirmChange && i.routine_id.as_deref() == Some(&routine))
            .collect::<Vec<_>>()
    };
    assert!(waiting(&routes).is_empty(), "drafts held for the user ask for nothing new");

    let mut bolder = blueprint(1);
    bolder["freedom"] = json!({"rung": "send_then_tell"});
    let first = routes.propose(&architect, bolder.clone()).await;
    let items = waiting(&routes);
    assert_eq!(items.len(), 1);
    assert_eq!(version_of(&items[0].payload), json!(first));
    let second = routes.propose(&architect, bolder).await;
    let open = waiting(&routes);
    assert_eq!(open.len(), 1, "the newer proposal takes its place");
    assert_eq!(open[0].state, ItemState::Open);
    assert_eq!(version_of(&open[0].payload), json!(second));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_goes_to_a_young_architect_and_an_old_routine_gets_a_new_one() {
    let routes = Routes::new();
    let (routine, architect) = routes.made("Review my pull requests").await;
    routes.propose(&architect, blueprint(1)).await;
    routes.post(&format!("/api/routines/{routine}/start"), json!({"withoutTrial": true})).await;
    let workers = |routes: &Routes| {
        let mut ids: Vec<String> = routes.bench.agents.started().into_iter().map(|spec| spec.worker_id).collect();
        ids.dedup();
        ids
    };
    let before = workers(&routes);

    let (status, draft) =
        routes.post(&format!("/api/routines/{routine}/change"), json!({"text": "Look at the tests too."})).await;
    assert_eq!((status, &draft["status"]), (200, &json!("working")), "{draft}");
    let bench = &routes.bench;
    bench
        .eventually(|| bench.agents.sent(&architect).iter().any(|text| text.ends_with("\nLook at the tests too.")))
        .await;
    assert_eq!(workers(&routes), before, "revived, no new architect");
    assert_eq!(routes.draft_row(&routine).architect_id.as_deref(), Some(architect.as_str()));

    bench.clock.advance(8 * DAY);
    routes.post(&format!("/api/routines/{routine}/change"), json!({"text": "Skip drafts."})).await;
    let fresh = routes.draft_row(&routine).architect_id.expect("an architect");
    assert_ne!(fresh, architect, "a new architect for an old routine");
    let started = bench.agents.started();
    let boot = started.iter().find(|spec| spec.worker_id == fresh).and_then(|spec| spec.prompt.clone());
    let boot = boot.expect("its first message");
    assert!(boot.contains("Skip drafts.") && boot.contains("\"name\":\"PR Review\""), "{boot}");
}

#[tokio::test(flavor = "multi_thread")]
async fn three_architects_work_at_once_and_leaving_a_draft_makes_room() {
    let routes = Routes::new();
    let mut made = Vec::new();
    for sentence in ["One", "Two", "Three"] {
        made.push(routes.made(sentence).await);
    }
    let (status, refused) = routes.post("/api/routines/architect", json!({"sentence": "Four"})).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(routes.get("/api/routines").await.1.as_array().map(Vec::len), Some(3), "nothing was made");

    let (routine, architect) = &made[0];
    let (status, left) = routes.delete(&format!("/api/routines/{routine}/draft")).await;
    assert_eq!((status, &left["status"]), (200, &json!("abandoned")), "{left}");
    assert_eq!(routes.worker_state(architect).await, WorkerState::Suspended);
    assert_eq!(routes.post("/api/routines/architect", json!({"sentence": "Four"})).await.0, 201);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_head_made_by_a_newer_eos_is_listed_and_read_but_never_started_run_or_changed() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let newer = StoredVersion {
        id: "rv-newer".into(),
        routine_id: routine.clone(),
        parent_id: None,
        status: VersionStatus::Kept,
        author: VersionAuthor::Sync,
        note: None,
        format: 2,
        blueprint: json!({"format": 2, "name": "PR Review", "summary": "Reviews.", "icon": "eye"}).to_string(),
        hash: "ab".into(),
        no_trial: false,
        trust: Trust::Trusted,
        device: None,
        created_at: 5,
    };
    let id = routine.clone();
    routes
        .bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            tx.routine_versions().insert(&newer)?;
            tx.routines().set_head(&id, "rv-newer", 5)
        })
        .expect("writes");

    let (_, list) = routes.get("/api/routines").await;
    assert_eq!((&list[0]["id"], &list[0]["summary"]), (&json!(routine), &json!("Reviews.")), "{list}");
    let (status, detail) = routes.get(&format!("/api/routines/{routine}")).await;
    assert_eq!((status, &detail["head"]["runnable"]), (200, &json!(false)), "{detail}");

    let newer_format = |(status, body): (u16, Value)| status == 409 && body["code"] == "newer_format";
    let run = json!({"routineId": routine, "input": {"item": pull_request(1), "result": "usual"}, "door": "home"});
    assert!(newer_format(routes.post("/api/runs", run).await), "run");
    assert!(newer_format(routes.post(&format!("/api/routines/{routine}/change"), json!({"text": "x"})).await));
    assert!(newer_format(routes.post(&format!("/api/routines/{routine}/start"), json!({})).await), "start");
    let keep = json!({"baseVersionId": "rv-newer", "blueprint": blueprint(1)});
    assert!(newer_format(
        routes.call(Method::Put, Caller::DASHBOARD, &format!("/api/routines/{routine}/blueprint"), Some(keep)).await
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hand_save_after_the_architects_draft_is_the_version_that_starts() {
    let routes = Routes::new();
    let (routine, architect) = routes.made("Review my pull requests").await;
    let drafted = routes.propose(&architect, blueprint(1)).await;
    let mut edited = blueprint(1);
    edited["summary"] = json!("Reviews, by hand.");
    let body = json!({"baseVersionId": drafted, "blueprint": edited});
    let path = format!("/api/routines/{routine}/blueprint");
    let (status, saved) = routes.call(Method::Put, Caller::DASHBOARD, &path, Some(body)).await;
    assert_eq!(status, 200, "{saved}");
    let by_hand = saved["versionId"].as_str().expect("a version").to_owned();

    let (status, row) = routes.post(&format!("/api/routines/{routine}/start"), json!({"withoutTrial": true})).await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(routes.routine_head(&routine).as_deref(), Some(by_hand.as_str()), "the version the editor shows");
}
