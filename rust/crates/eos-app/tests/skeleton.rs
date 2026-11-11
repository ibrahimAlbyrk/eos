//! The composed app, end to end: a data folder in, answered requests out.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, Options};
use eos_runtime::http::{Method, Request};
use eos_testkit::{FakeClock, SeqIds, TempHome};

fn options(home: &TempHome) -> Options {
    Options { home: home.path().to_owned(), clock: Arc::new(FakeClock::new()), ids: Arc::new(SeqIds::new()) }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_data_folder_becomes_a_router_that_answers() {
    let home = TempHome::new();
    let app = App::build(options(&home)).expect("builds");
    app.start().await.expect("starts");

    let router = app.router();
    assert_eq!(router.undeclared(), Vec::<String>::new(), "every route states who may call it");

    let dashboard = app.callers().classify(Some(app.callers().ui_token()));
    let focus = Request::new(Method::Post, "/stream/focus", dashboard.clone())
        .body(r#"{"clientId":"tab-1","workers":["w-1"],"ptys":[]}"#);
    let res = router.handle(focus).await;
    assert_eq!(res.status, 200);
    assert_eq!(&res.body.collect().await.expect("a body")[..], br#"{"live":[]}"#);

    let invalid = Request::new(Method::Post, "/stream/focus", dashboard).body(r#"{"workers":"w-1"}"#);
    let res = router.handle(invalid).await;
    assert_eq!(res.status, 400);

    let unknown = router.handle(Request::new(Method::Get, "/nope", app.callers().classify(None))).await;
    assert_eq!(unknown.status, 404);

    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_reach_the_bus_in_the_order_they_were_saved() {
    let home = TempHome::new();
    let app = App::build(options(&home)).expect("builds");
    app.start().await.expect("starts");
    let mut heard = app.runtime().kernel.bus.subscribe("worker:change", 256);

    // Many tasks write at once; each announces the event row it appended.
    let store = app.store();
    let writers: Vec<_> = (0..8)
        .map(|w| {
            let store = store.clone();
            tokio::spawn(async move {
                for _ in 0..20 {
                    let appended = store.write(move |tx, out| {
                        let row =
                            tx.events().append(&format!("w-{w}"), 1, eos_contracts::WorkerEventType::State, None)?;
                        out.push("worker:change", &row);
                        Ok(row)
                    });
                    appended.await.expect("writes");
                }
            })
        })
        .collect();
    for writer in writers {
        writer.await.expect("a writer task");
    }

    let mut rows = Vec::new();
    for _ in 0..160 {
        let event =
            tokio::time::timeout(Duration::from_secs(5), heard.recv()).await.expect("in time").expect("an event");
        rows.push(event.payload_as::<i64>().expect("a row id"));
    }
    assert_eq!(rows, (1..=160).collect::<Vec<i64>>(), "announced in commit order, none lost");

    assert!(app.shutdown(Duration::from_secs(5)).await.clean());
    let wal = std::fs::metadata(home.join("state.db-wal")).map(|m| m.len()).unwrap_or(0);
    assert_eq!(wal, 0, "shutdown folds the WAL into the file");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_folder_is_reopened_as_it_was_left() {
    let home = TempHome::new();
    let first = App::build(options(&home)).expect("builds");
    let token = first.callers().ui_token().to_owned();
    first.start().await.expect("starts");
    first.shutdown(Duration::from_secs(5)).await;
    drop(first);

    let again = App::build(options(&home)).expect("builds on the same folder");
    assert_eq!(again.callers().ui_token(), token);
}
