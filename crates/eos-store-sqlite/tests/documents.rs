//! The tables of JSON documents, with documents today's daemon answered
//! (`fixtures/wire`): what is saved comes back as the same wire JSON.

use eos_contracts::{DreamRun, ViewRecord, ViewState};
use eos_testkit::{TempStore, fixtures};
use serde_json::{Value, json};

/// A recorded document with its placeholders filled in.
fn recorded(scenario: &str, step: &str, pointer: &str, fill: &[(&str, Value)]) -> Value {
    let mut doc = fixtures::recorded_response(scenario, step)["json"].pointer(pointer).expect("the document").clone();
    for (key, value) in fill {
        doc[*key] = value.clone();
    }
    doc
}

#[test]
fn a_visual_answer_and_its_state_come_back_as_saved() {
    let doc = recorded(
        "37-genui",
        "view",
        "",
        &[("id", json!("v_AAAAAAAAAAAB")), ("createdAt", json!(1_790_000_000_000_i64))],
    );
    let view: ViewRecord = eos_contracts::parse(&doc).expect("a recorded view is a valid record");
    let state: ViewState = serde_json::from_value(json!({ "tab": "map", "picked": ["a"] })).expect("a state");
    let temp = TempStore::new();
    let (read, stored_state, missing) = temp
        .store
        .write_blocking({
            let (view, state) = (view.clone(), state.clone());
            move |tx, _| {
                let views = tx.genui_views();
                views.save(&view)?;
                views.save(&view)?;
                views.put_state("v_AAAAAAAAAAAB", &state, 5)?;
                views.put_state("v_AAAAAAAAAAAB", &state, 9)?;
                Ok((views.get("v_AAAAAAAAAAAB")?, views.get_state("v_AAAAAAAAAAAB")?, views.get("v_AAAAAAAAAAAC")?))
            }
        })
        .expect("writes");
    assert_eq!(serde_json::to_value(read.expect("the view")).expect("serializes"), doc, "the same wire JSON");
    assert_eq!(stored_state.map(|s| (s.state, s.updated_at)), Some((state, 9)));
    assert_eq!(missing, None);

    // A row whose document no longer fits is skipped, not an error.
    temp.exec("UPDATE genui_views SET data = 'not json' WHERE id = 'v_AAAAAAAAAAAB'");
    assert_eq!(temp.store.read_blocking(|tx| tx.genui_views().get("v_AAAAAAAAAAAB")).expect("reads"), None);

    let worker = doc["workerId"].as_str().expect("a worker").to_owned();
    let gone = temp
        .store
        .write_blocking(move |tx, _| {
            tx.genui_views().remove_by_worker(&worker)?;
            tx.genui_views().get_state("v_AAAAAAAAAAAB")
        })
        .expect("writes");
    assert_eq!(gone, None, "a worker's views go with their states");
}

#[test]
fn dream_runs_watermarks_and_exclusions() {
    let fill = |id: &str, at: i64| [("id", json!(id)), ("startedAt", json!(at)), ("finishedAt", json!(at + 10))];
    let older = recorded("20-reads", "dreams", "/runs/0", &fill("dr-000000000001", 100));
    let newer = recorded("20-reads", "dreams", "/runs/0", &fill("dr-000000000002", 200));
    let runs: Vec<DreamRun> =
        [&older, &newer].into_iter().map(|d| eos_contracts::parse(d).expect("a recorded run is valid")).collect();
    let temp = TempStore::new();
    let outcome = temp
        .store
        .write_blocking(move |tx, _| {
            let dreams = tx.dreams();
            for run in &runs {
                dreams.save(run)?;
            }
            dreams.save(&runs[0])?;
            assert_eq!(dreams.watermark("w-1")?, 0);
            dreams.set_watermark("w-1", 40)?;
            dreams.set_watermark("w-1", 55)?;
            dreams.set_excluded("w-2", true)?;
            dreams.set_excluded("w-2", true)?;
            dreams.set_excluded("w-3", true)?;
            dreams.set_excluded("w-3", false)?;
            assert!(dreams.candidates()?.is_empty());
            dreams.replace_candidates(&[])?;
            Ok((
                dreams.list(10)?,
                dreams.list(1)?.len(),
                dreams.get("dr-000000000001")?,
                dreams.watermark("w-1")?,
                dreams.excluded()?,
            ))
        })
        .expect("writes");
    let (listed, capped, one, watermark, excluded) = outcome;
    let wire: Vec<Value> = listed.iter().map(|r| serde_json::to_value(r).expect("serializes")).collect();
    assert_eq!(wire, [newer, older.clone()], "newest first, each run once, the same wire JSON");
    assert_eq!(capped, 1);
    assert_eq!(one.map(|r| serde_json::to_value(r).expect("serializes")), Some(older));
    assert_eq!((watermark, excluded), (55, vec!["w-2".to_owned()]));
}

#[test]
fn a_transfer_row_that_does_not_fit_is_skipped() {
    let temp = TempStore::new();
    temp.exec(
        "INSERT INTO transfers (id, created_at, data) VALUES ('tr-000000000001', 5, '{\"id\":\"tr-000000000001\"}')",
    );
    let (listed, one) = temp
        .store
        .write_blocking(|tx, _| {
            let transfers = tx.transfers();
            let found = (transfers.list(10)?, transfers.get("tr-000000000001")?);
            transfers.remove(&["tr-000000000001".to_owned()])?;
            Ok(found)
        })
        .expect("writes");
    assert!(listed.is_empty() && one.is_none());
}
