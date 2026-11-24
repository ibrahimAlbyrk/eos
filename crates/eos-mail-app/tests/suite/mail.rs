//! Its manifest, its health check (-1743 is a step for the user), reads
//! that fit their schemas, an inbox poll that hands each mail on once by
//! its Message-ID, and a send of one mail to one address.

use std::collections::HashMap;
use std::sync::Arc;

use eos_core::capability::{ActionContext, ActionError, BuiltinCapability};
use eos_domain::capability::check::check_builtin;
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::capability::schema::compile;
use eos_mail_app::{MailApp, Parts, Program};
use eos_testkit::{FakeClock, FakeMail, FakeSleeper, SentMail};
use serde_json::{Value, json};

const NOW: i64 = 1_763_460_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const SURFACES: &str = "/data/surfaces";

struct Rig {
    mail: MailApp,
    fake: FakeMail,
}

fn rig_on(fake: FakeMail) -> Rig {
    let parts = Parts {
        script: Arc::new(fake.clone()),
        clock: Arc::new(FakeClock::at(NOW)),
        sleeper: Arc::new(FakeSleeper::default()),
        surfaces: SURFACES.into(),
    };
    Rig { mail: MailApp::new(parts), fake }
}

fn rig() -> Rig {
    rig_on(FakeMail::new())
}

fn ctx() -> ActionContext {
    ActionContext { secrets: HashMap::new(), settings: json!({}), idempotency_key: None }
}

impl Rig {
    /// The call, its output held to the schema its action declares.
    async fn call(&self, action: &str, input: Value) -> Result<Value, ActionError> {
        let output = self.mail.call(action, input, &ctx()).await?;
        let declared = self.mail.manifest().action(action).and_then(|action| action.output.clone());
        if let Some(schema) = declared {
            let mut issues = eos_contracts::Issues::default();
            compile(&schema).expect("a schema").check(&output, &mut issues);
            assert!(issues.is_empty(), "{action} answered outside its schema: {:?}", issues.into_vec());
        }
        Ok(output)
    }
}

#[test]
fn the_manifest_passes_the_built_in_check() {
    assert_eq!(check_builtin(rig().mail.manifest()), []);
}

#[tokio::test]
async fn a_refused_apple_event_is_a_step_for_the_user_and_no_account_fails_the_check() {
    assert_eq!(rig().mail.health(&ctx()).await, Event::Passed);
    let denied = rig_on(FakeMail::new().denying());
    assert_eq!(denied.mail.health(&ctx()).await, Event::Missing(StateCode::AutomationDenied));
    let call = denied.call("recent_mail", json!({})).await;
    assert_eq!(call, Err(ActionError::NotReady("automation_denied".into())));
    let empty = rig_on(FakeMail::new().with_accounts(0));
    assert_eq!(empty.mail.health(&ctx()).await, Event::CheckFailed);
}

#[tokio::test]
async fn reads_list_the_inbox_window_newest_first_and_read_one_mail_by_its_message_id() {
    let rig = rig();
    rig.fake.receive("old@x", "Ann <ann@x.dev>", "Old", "Long ago.", NOW - 49 * HOUR);
    rig.fake.receive("a@x", "Ann <ann@x.dev>", "Lunch?", "Are you free?", NOW - 2 * HOUR);
    rig.fake.receive("b@x", "Bo <bo@y.dev>", "Report", "Attached.", NOW - HOUR);
    let recent = rig.call("recent_mail", json!({})).await.expect("read");
    let ids: Vec<&str> =
        recent["messages"].as_array().expect("a list").iter().filter_map(|m| m["messageId"].as_str()).collect();
    assert_eq!(ids, ["b@x", "a@x"], "inside 48 hours, newest first");
    let read = rig.call("read_mail", json!({"messageId": "a@x"})).await.expect("read");
    assert_eq!((read["found"].clone(), read["body"].clone()), (json!(true), json!("Are you free?")));
    let missing = rig.call("read_mail", json!({"messageId": "nope@x"})).await.expect("read");
    assert_eq!(missing["found"], json!(false));
}

#[tokio::test]
async fn the_inbox_poll_marks_what_is_there_then_hands_on_each_new_mail_once() {
    let rig = rig();
    rig.fake.receive("a@x", "Ann <ann@x.dev>", "Lunch?", "Are you free?", NOW - HOUR);
    let first = rig.call("poll_inbox", json!({})).await.expect("polled");
    assert_eq!((first["baseline"].clone(), first["items"].clone()), (json!(true), json!([])));
    assert_eq!(first["cursor"], json!({"seen": ["a@x"]}));

    rig.fake.receive("b@x", "Bo <bo@y.dev>", "Report", "Attached.", NOW - 1);
    let second = rig.call("poll_inbox", json!({"cursor": first["cursor"]})).await.expect("polled");
    assert_eq!(second["baseline"], json!(false));
    assert_eq!(
        second["items"],
        json!([{"key": "mail:b@x", "event": "received", "title": "Report", "updatedAt": NOW - 1,
                "facts": {"from": "Bo <bo@y.dev>"}}])
    );
    let third = rig.call("poll_inbox", json!({"cursor": second["cursor"]})).await.expect("polled");
    assert_eq!(third["items"], json!([]), "a Message-ID seen once is not handed on again");
}

#[tokio::test]
async fn a_send_is_one_plain_mail_to_one_address() {
    let rig = rig();
    let input = json!({"to": "boss@acme.dev", "subject": "Overnight", "body": "Three mails came in."});
    assert_eq!(rig.call("send_mail", input).await.expect("sent"), json!({"sent": true}));
    let sent =
        SentMail { to: "boss@acme.dev".into(), subject: "Overnight".into(), body: "Three mails came in.".into() };
    assert_eq!(rig.fake.sent(), [sent]);
    assert_eq!(rig.fake.programs(), [Program::Send]);
}

#[tokio::test]
async fn a_page_goes_with_its_html_images_and_export_pdf_and_no_other_file() {
    let rig = rig();
    let page = json!({
        "to": "boss@acme.dev", "subject": "Morning Paper · No. 1", "body": "Text part.", "html": "<table></table>",
        "images": [{"cid": "abc@eos", "contentType": "image/png", "data": "UE5H"}],
        "pdf": format!("{SURFACES}/sf-1/exports/si-1.pdf"),
    });
    assert_eq!(rig.call("send_mail", page.clone()).await.expect("sent"), json!({"sent": true}));
    assert_eq!(rig.fake.sends(), std::slice::from_ref(&page));
    for elsewhere in [
        "/Users/me/.ssh/id_rsa.pdf",
        "/data/surfaces/sf-1/exports/../../../secret.pdf",
        "/data/surfaces/sf-1/img/a.pdf",
        "/data/surfaces/sf-1/exports/si-1.html",
        "/data/surfaces/sf-1/exports/deeper/si-1.pdf",
        "sf-1/exports/si-1.pdf",
    ] {
        let mut input = page.clone();
        input["pdf"] = json!(elsewhere);
        let refused = rig.call("send_mail", input).await;
        assert!(matches!(refused, Err(ActionError::Invalid(_))), "{elsewhere}: {refused:?}");
    }
    assert_eq!(rig.fake.sends().len(), 1, "a refused file sends nothing");
}
