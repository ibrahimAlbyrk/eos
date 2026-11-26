//! PR Review's pull-request source and six of its signals: three that ran
//! (the sample runs), one opened before the routine started, one its rules
//! left out and one waiting in a batch. Morning Paper's schedule is armed.

use eos_core::Error;
use eos_core::store::{NewSignal, StoredSignalRoute, StoredSignalSchedule, StoredSignalSource, Tx};
use eos_domain::signals::decision::Decision;
use serde_json::json;

use crate::routine_seed::{
    BASE_MS, DAY, MINUTE, MORNING_PAPER, PR_REVIEW, PR_REVIEW_HEAD, RUN_FAILED, RUN_NOTHING, RUN_SHOWN,
};

const SOURCE: &str = "ss-sample000001";

pub(super) fn write(tx: &dyn Tx) -> Result<(), Error> {
    let scope = json!({"repo": "acme/game"}).to_string();
    tx.signal_sources().insert(&StoredSignalSource {
        id: SOURCE.to_owned(),
        kind: "capability".to_owned(),
        source: Some("github.pulls".to_owned()),
        scope_hash: "sample:github.pulls:acme/game".to_owned(),
        scope_json: scope,
        cursor_json: None,
        state: "active".to_owned(),
        error_kind: None,
        failures: 0,
        interval_ms: 5 * MINUTE,
        last_poll_at: Some(BASE_MS - 2 * MINUTE),
        next_poll_at: Some(BASE_MS + 3 * MINUTE),
        last_signal_at: Some(BASE_MS - 70 * MINUTE),
        catch_up_json: None,
        stopped_at: None,
        created_at: BASE_MS - 10 * DAY,
        updated_at: BASE_MS - 2 * MINUTE,
    })?;
    let signals = [
        (466, 26 * 60, Decision::Baseline, None),
        (467, 5 * 60, Decision::Unmatched, None),
        (468, 3 * 60 + 5, Decision::Run, Some(RUN_FAILED)),
        (469, 2 * 60 + 5, Decision::Run, Some(RUN_NOTHING)),
        (470, 65, Decision::Run, Some(RUN_SHOWN)),
        (471, 10, Decision::Batched, None),
    ];
    for (number, minutes_ago, decision, run) in signals {
        let at = BASE_MS - minutes_ago * MINUTE;
        let subject = format!("github:pr:acme/game#{number}");
        let item = json!({"kind": "github.pull_request", "key": subject, "title": format!("Pull request #{number}"),
                          "version": "abc1234", "untrusted": true});
        let new = NewSignal {
            source_id: SOURCE.to_owned(),
            key: format!("{subject}@abc1234"),
            subject,
            version: Some("abc1234".to_owned()),
            kind: "opened".to_owned(),
            occurred_at: at - MINUTE,
            received_at: at,
            facts_json: Some(json!({"repo": "acme/game", "draft": false}).to_string()),
            item_json: item.to_string(),
            depth: 0,
        };
        let Some(id) = tx.signals().ingest(&new)? else { continue };
        tx.signals().mark_routed(id)?;
        tx.signal_routes().insert(&StoredSignalRoute {
            signal_id: id,
            routine_id: PR_REVIEW.to_owned(),
            routine_version: PR_REVIEW_HEAD.to_owned(),
            decision,
            reason: (decision == Decision::Unmatched).then(|| "0".to_owned()),
            run_id: run.map(str::to_owned),
            model_asked: false,
            decided_at: at,
        })?;
    }
    tx.signal_schedules().put(&StoredSignalSchedule {
        routine_id: MORNING_PAPER.to_owned(),
        slot: 0,
        spec_hash: "sample".to_owned(),
        zone: "Europe/Istanbul".to_owned(),
        armed_at: BASE_MS - 10 * DAY,
        last_slot_at: Some(BASE_MS - 6 * 60 * MINUTE),
        next_at: Some(BASE_MS + 18 * 60 * MINUTE),
        missed: 0,
        late_by_ms: 0,
        updated_at: BASE_MS - 6 * 60 * MINUTE,
    })
}
