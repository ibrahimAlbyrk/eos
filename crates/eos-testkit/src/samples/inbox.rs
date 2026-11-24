//! A Needs-you item of every kind, open, with the payload its card reads.

use eos_core::Error;
use eos_core::store::{StoredItem, Tx};
use eos_domain::inbox::{Attention, ItemKind, ItemState};
use serde_json::{Value, json};

use super::surfaces::MORNING_MAIL;
use crate::routine_seed::{BASE_MS, MINUTE, MORNING_PAPER, PR_REVIEW, RUN_SHOWN};

struct Sample {
    kind: ItemKind,
    routine: Option<&'static str>,
    run: Option<&'static str>,
    attention: Attention,
    title: &'static str,
    summary: &'static str,
    payload: Value,
}

fn review_doc() -> Value {
    json!({"kind": "github.review", "channel": "github", "action": "post_review", "parts": [
        {"key": "event", "role": "event", "text": "REQUEST_CHANGES"},
        {"key": "summary", "role": "summary", "text": "The login fix works, but **one change blocks**: the token is logged."},
        {"key": "c:1", "role": "comment", "text": "This line writes the session token to the log.",
         "meta": {"path": "src/login.rs", "line": 42, "side": "RIGHT"}},
    ]})
}

fn samples() -> Vec<Sample> {
    let sample = |kind, routine, run, attention, title, summary, payload| Sample {
        kind,
        routine,
        run,
        attention,
        title,
        summary,
        payload,
    };
    vec![
        sample(
            ItemKind::Draft,
            Some(PR_REVIEW),
            Some(RUN_SHOWN),
            Attention::Digest,
            "Review of #470",
            "Three comments on the login fix.",
            json!({"doc": review_doc(), "flags": [], "costUsd": 0.61, "verdict": null,
                   "targets": [{"recipientId": "pr", "place": {"item": "github:pr:acme/game#470"}}],
                   "rung": "draft", "untrusted": true}),
        ),
        sample(
            ItemKind::RunStart,
            Some(PR_REVIEW),
            None,
            Attention::Digest,
            "Review #471?",
            "A new pull request waits for its review.",
            json!({}),
        ),
        sample(
            ItemKind::Question,
            Some(PR_REVIEW),
            Some(RUN_SHOWN),
            Attention::Interrupt,
            "Which branch?",
            "The review needs a branch to compare against.",
            json!({"questions": [{"question": "Which branch should the review compare against?", "header": "Branch",
                                  "options": [{"label": "release/2.4"}, {"label": "main"}]}]}),
        ),
        sample(
            ItemKind::Permission,
            Some(PR_REVIEW),
            Some(RUN_SHOWN),
            Attention::Interrupt,
            "Push a branch?",
            "The reviewer wants to push review/470.",
            json!({"pendingId": "pa-sample00001", "workerId": "w-sample000001", "toolName": "Bash",
                   "input": {"command": "git push origin review/470"}, "offers": ["allow_once", "deny"]}),
        ),
        sample(
            ItemKind::CapabilityInstall,
            None,
            None,
            Attention::Digest,
            "Add Calendar?",
            "Reads your calendar so the morning routine knows your meetings.",
            json!({"runId": "rn-4k8m2q6w0e3r", "capabilityId": "calendar", "name": "Calendar",
                   "summary": "Reads today's events from the Calendar app.",
                   "actions": [{"name": "list_events", "summary": "List today's events", "class": "read"}],
                   "reach": {"hosts": [], "apps": ["com.apple.iCal"], "files": []},
                   "secrets": [], "settings": [], "cost": "free", "tests": {"passed": true, "tolerated": 2},
                   "review": {"verdict": "pass", "findings": []}, "routines": [], "limits": []}),
        ),
        sample(
            ItemKind::CapabilityAttention,
            Some(MORNING_MAIL),
            None,
            Attention::Interrupt,
            "Mail needs your permission",
            "macOS refused Eos's request to drive Mail.",
            json!({"capabilityId": "mail", "stateCode": "automation_denied"}),
        ),
        sample(
            ItemKind::AboutYou,
            None,
            None,
            Attention::Silent,
            "Is this right about you?",
            "You prefer short reviews with the blocking findings first.",
            json!({"memory": {"id": "um-sample00001", "text": "You prefer short reviews with the blocking findings first."}}),
        ),
        sample(
            ItemKind::RoutineAlert,
            Some(MORNING_PAPER),
            None,
            Attention::Interrupt,
            "Morning Paper is paused",
            "Paused after three failed runs in a row.",
            json!({"reason": "failures"}),
        ),
        sample(
            ItemKind::FreedomOffer,
            Some(PR_REVIEW),
            None,
            Attention::Digest,
            "Let PR Review post by itself?",
            "Its last ten reviews went out as written.",
            json!({"from": "draft", "rung": "send_then_tell", "streak": 10}),
        ),
        sample(
            ItemKind::ConfirmChange,
            Some(MORNING_MAIL),
            None,
            Attention::Digest,
            "Confirm a new recipient",
            "The architect added team@example.com to Morning Mail.",
            json!({}),
        ),
        sample(
            ItemKind::DeliveryProblem,
            Some(PR_REVIEW),
            Some(RUN_SHOWN),
            Attention::Interrupt,
            "The review of #470 could not be posted",
            "GitHub says the pull request is gone.",
            json!({"errorKind": "gone", "deliveryId": "dl-sample00001", "doc": review_doc()}),
        ),
        sample(
            ItemKind::Suggestion,
            None,
            None,
            Attention::Silent,
            "You often ask for this. Make it a routine?",
            "Sum up the night's mail every morning.",
            json!({"sentence": "Sum up the night's mail every morning.", "taskKey": "mail-digest"}),
        ),
        sample(
            ItemKind::Notice,
            Some(MORNING_PAPER),
            None,
            Attention::Silent,
            "Keep the Mac awake for schedules?",
            "Morning Paper missed a slot while the Mac slept.",
            json!({"actionLabel": "Keep the Mac awake for schedules"}),
        ),
    ]
}

pub(super) fn write(tx: &dyn Tx) -> Result<(), Error> {
    for (i, sample) in samples().into_iter().enumerate() {
        let at = BASE_MS - (i as i64 + 1) * 7 * MINUTE;
        tx.inbox_items().insert(&StoredItem {
            id: format!("nd-5a3b1e0000{:02}", i + 1),
            kind: sample.kind,
            state: ItemState::Open,
            producer: "sample".to_owned(),
            routine_id: sample.routine.map(str::to_owned),
            run_id: sample.run.map(str::to_owned),
            subject_key: None,
            title: sample.title.to_owned(),
            summary: sample.summary.to_owned(),
            payload: sample.payload.to_string(),
            working: None,
            rev: 1,
            attention: sample.attention,
            stale_at: None,
            stale_reason: None,
            later_until: None,
            expires_at: None,
            created_at: at,
            updated_at: at,
            answered_at: None,
            answered_by: None,
            answer: None,
            replaced_by: None,
            consumed_at: None,
            notified_at: None,
        })?;
    }
    Ok(())
}
