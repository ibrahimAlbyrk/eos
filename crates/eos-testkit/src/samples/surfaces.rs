//! "Morning Mail": a routine that reads the night's mail through the Mail
//! app and answers with a View in Needs you, its surface with three issues,
//! one for each of its last three mornings.

use eos_contracts::{RoutineState, RunInput, VersionAuthor};
use eos_core::Error;
use eos_core::store::{RUN_STATE_EVENT, RunMove, StoredIssue, StoredRun, StoredSurface, Tx};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{RunState, Station};
use eos_surface::{IssueKind, IssueStatus, Level, Place, Role};
use serde_json::{Value, json};

use crate::routine_seed::{BASE_MS, DAY, DEVICE, MINUTE, agent, routine, version};

pub const MORNING_MAIL: &str = "rt-sample000004";
const MORNING_MAIL_HEAD: &str = "rv-sample000005";
pub const MAIL_SURFACE: &str = "sf-5a3b1e000001";
/// Oldest first.
pub const MAIL_ISSUES: [&str; 3] = ["si-5a3b1e000001", "si-5a3b1e000002", "si-5a3b1e000003"];
const MAIL_RUNS: [&str; 3] = ["rn-sample000005", "rn-sample000006", "rn-sample000007"];

pub(super) fn morning_mail() -> Value {
    json!({
        "format": 1, "name": "Morning Mail", "summary": "Sums up the night's mail and drafts replies to the team.",
        "icon": "mail", "kind": "standing",
        "takes": {"kind": "none", "label": "nothing", "placeholder": "", "empty": "none", "many": false},
        "when": {"on": [{"schedule": {"daily": "07:30", "days": "weekdays", "zone": "Europe/Istanbul"}}]},
        "which": {},
        "who": {"depth": "solo", "agents": [agent("reader", "Mail reader", true, true, "none")],
                "checker": {"model": "sonnet", "effort": "low"}},
        "how": {"checks": [], "format": "digest", "checkAgent": false},
        "makes": {"kind": "view", "description": "A digest of the night's mail."},
        "goesTo": [{"id": "me", "kind": "me", "channel": "notify"}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunMinutes": 15, "parallel": 1},
        "needs": ["mail"],
    })
}

/// What the run of the morning `days_ago` handed back with `return_view`.
fn body(mails: u32, first: &str) -> Value {
    json!({
        "place": "result",
        "view": {
            "title": "Overnight mail",
            "summary": format!("{mails} mails came in; the first is from {first}."),
            "ui": format!("<Callout action=\"again\">{mails} mails came in overnight.</Callout>"),
            "actions": {"again": {"label": "Run again", "kind": "send", "text": "again"}},
        },
        "bindings": {"again": {"action": "routine.run_again", "args": {}}},
    })
}

fn input() -> String {
    let input: RunInput = serde_json::from_value(json!({"result": "usual"})).expect("an input");
    serde_json::to_string(&input).expect("JSON")
}

fn write_run(tx: &dyn Tx, id: &str, at: i64) -> Result<(), Error> {
    tx.runs().insert(&StoredRun {
        id: id.to_owned(),
        routine_id: MORNING_MAIL.to_owned(),
        version_id: Some(MORNING_MAIL_HEAD.to_owned()),
        kind: "standing".to_owned(),
        origin: "schedule".to_owned(),
        origin_ref: None,
        door: None,
        input: input(),
        item_key: None,
        state: RunState::Queued,
        station: None,
        reason: None,
        attempt: 1,
        resumed: 0,
        not_before: None,
        priority: 0,
        progress_done: None,
        progress_total: None,
        headline: Some("Overnight mail".to_owned()),
        outcome: None,
        cost_usd: 0.0,
        work_ms: 0,
        lead_id: None,
        device: DEVICE.to_owned(),
        remote: false,
        created_at: at,
        started_at: None,
        ended_at: None,
        updated_at: at,
    })?;
    tx.runs().append_event(id, at, RUN_STATE_EVENT, Some(r#"{"state":"queued"}"#))?;
    for (i, (state, station)) in
        [(RunState::Running, Station::Brief), (RunState::Running, Station::Work), (RunState::Done, Station::Gate)]
            .into_iter()
            .enumerate()
    {
        let move_at = at + (i as i64 + 1) * MINUTE;
        tx.runs().move_to(id, &RunMove { state, station: Some(station), reason: None, at: move_at })?;
    }
    tx.runs().set_outcome(id, Outcome::Shown)?;
    tx.runs().set_spent(id, 0.09, 3 * MINUTE)
}

pub(super) fn write(tx: &dyn Tx) -> Result<(), Error> {
    let created = BASE_MS - 5 * DAY;
    tx.routines().insert(&routine(
        MORNING_MAIL,
        "Morning Mail",
        RoutineState::Active,
        Some(MORNING_MAIL_HEAD),
        "hand",
    ))?;
    tx.routine_versions().insert(&version(
        MORNING_MAIL_HEAD,
        MORNING_MAIL,
        None,
        VersionAuthor::User,
        &morning_mail(),
    ))?;
    tx.surfaces().put(&StoredSurface {
        id: MAIL_SURFACE.to_owned(),
        routine_id: MORNING_MAIL.to_owned(),
        level: Level::View,
        place: Place::NeedsYou,
        role: Role::Result,
        title: "Morning Mail".to_owned(),
        current_version: None,
        candidate_version: None,
        needs_redesign_json: None,
        archived_at: None,
        created_at: created,
        updated_at: created,
    })?;
    let mornings = [(3, 9, "Dana"), (2, 4, "Kerem"), (1, 12, "the build server")];
    for (seq, ((days_ago, mails, first), (issue, run))) in
        mornings.into_iter().zip(MAIL_ISSUES.into_iter().zip(MAIL_RUNS)).enumerate()
    {
        let at = BASE_MS - days_ago * DAY;
        write_run(tx, run, at)?;
        tx.surface_issues().put(&StoredIssue {
            id: issue.to_owned(),
            surface_id: MAIL_SURFACE.to_owned(),
            seq: Some(seq as i64 + 1),
            run_id: Some(run.to_owned()),
            version: None,
            kind: IssueKind::View,
            status: IssueStatus::Ready,
            body_json: body(mails, first).to_string(),
            rev: 1,
            images_json: "[]".to_owned(),
            trial: false,
            kept: false,
            created_at: at + 3 * MINUTE,
            updated_at: at + 3 * MINUTE,
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use eos_domain::routine::blueprint::{Context, Readable, Severity, read, validate};
    use eos_genui::{ViewValidation, validate_view};
    use serde::Deserialize;

    use super::*;

    #[test]
    fn the_mail_routine_and_its_views_meet_the_rules() {
        let Ok(Readable::Current(typed)) = read(&morning_mail()) else { panic!("it reads") };
        let context = Context { routine: MORNING_MAIL, chains: &[], known_zone: &|_| true, data_dir: None };
        let errors: Vec<_> =
            validate(&typed, &context).into_iter().filter(|issue| issue.severity == Severity::Error).collect();
        assert!(errors.is_empty(), "{errors:?}");
        let view = eos_genui::Value::deserialize(&body(3, "Dana")["view"]).expect("a value");
        assert!(!matches!(validate_view(&view), ViewValidation::Rejected { .. }), "a View the kit shows");
    }
}
