//! Routines: a routine made by hand from a planted blueprint that names a planted
//! recipient, a run of it started on a pull request with a planted title and note, its
//! lead's planted result held as a draft, the user's edit of it and its send, whose receipt
//! names a planted link. The log tells the routine, the run and the send by id; none of the eight
//! reaches it.

use std::time::Duration;

use eos_core::delivery::Receipt;
use eos_runtime::http::Method;
use eos_testkit::TempHome;
use serde_json::{Value, json};

use crate::routines_rig::{
    Fakes, eventually, hand_in, inbox, make, review_blueprint, review_doc, runs, working_agents,
};
use crate::{Area, rig};

const BLUEPRINT: &str = "PLANTED-blueprint-brief-heron-quill";
const TITLE: &str = "PLANTED-item-title-marten-gable";
const NOTE: &str = "PLANTED-run-note-wren-cistern";
const RESULT: &str = "PLANTED-result-headline-otter-spire";
const DRAFT: &str = "PLANTED-draft-text-lynx-harbor";
const EDIT: &str = "PLANTED-edit-text-finch-meadow";
const RECEIPT: &str = "https://mail.example.org/sent/PLANTED-receipt-curlew";
const RECIPIENT: &str = "planted.routine.recipient@example.org";

/// The review routine; besides the pull request it names a mail recipient the user confirms
/// with it.
fn blueprint() -> Value {
    let mut blueprint = review_blueprint(BLUEPRINT);
    blueprint["how"] = json!({"checks": [], "format": "review", "checkAgent": false});
    let recipient = json!({"id": "boss", "kind": "fixed", "channel": "mail", "address": RECIPIENT});
    blueprint["goesTo"].as_array_mut().expect("recipients").push(recipient);
    blueprint
}

pub(crate) async fn steps() -> Area {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    // On the network, so the send goes out through the fake channel and comes back with a receipt.
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let routine = make(&app, blueprint()).await;

    let item = json!({"kind": "github.pull_request", "key": "github:pr:acme/game#9", "title": TITLE, "version": "c1",
                 "untrusted": true});
    let start = json!({"routineId": routine, "door": "routine_page",
                       "input": {"item": item, "note": NOTE, "result": "usual"}});
    let (status, started) = rig::call(&app, Method::Post, "/api/runs", Some(start)).await;
    assert!(status < 300, "{started}");
    let run = runs(&app, &routine).await.remove(0).id;
    hand_in(&app, &agents, &run, RESULT, review_doc(DRAFT), false).await;
    eventually("the draft waits", || async { !inbox(&app).await.is_empty() }).await;
    let draft = inbox(&app).await.remove(0);
    let id = draft["id"].as_str().expect("an id").to_owned();
    let rev = draft["rev"].as_i64().expect("a rev");

    let edit = json!({"rev": rev, "doc": review_doc(EDIT)});
    let (status, saved) = rig::call(&app, Method::Put, &format!("/api/inbox/{id}/draft"), Some(edit)).await;
    assert_eq!(status, 200, "{saved}");
    fakes.channels.script(Ok(Receipt { id: "rc-routine".into(), url: Some(RECEIPT.into()) }));
    let (status, sent) =
        rig::call(&app, Method::Post, &format!("/api/inbox/{id}/send"), Some(json!({"rev": rev + 1}))).await;
    assert_eq!(status, 200, "{sent}");
    eventually("the send goes out", || async { !fakes.channels.sent().is_empty() }).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    app.shutdown(Duration::from_secs(5)).await;

    let planted = [BLUEPRINT, TITLE, NOTE, RESULT, DRAFT, EDIT, RECEIPT, "PLANTED-receipt-curlew", RECIPIENT];
    let told = [
        routine.as_str(),
        run.as_str(),
        "a routine was made by hand",
        "a run's result was handed in",
        "a delivery moved",
    ];
    Area { planted: planted.map(str::to_owned).to_vec(), told: told.map(str::to_owned).to_vec() }
}
