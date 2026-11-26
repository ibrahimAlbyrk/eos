//! Sample routines for tests and the dashboard's screens: "PR Review"
//! (standing, active, a team of three, two kept versions, its finished runs
//! with their timelines, a checked review result and a trial), "Morning
//! Paper" (paused after failures) and "Release Notes" (a draft its architect
//! works on), and a day of spend. Ids and times are fixed, so a second
//! [`seed`] finds them and writes nothing. The replay seed
//! (`fixtures/wire/seed`) is another thing and stays as it is.

use eos_contracts::{DraftStatus, RoutineKind, RoutineState, RunInput, VersionAuthor, VersionStatus};
use eos_core::Error;
use eos_core::store::{
    RUN_STATE_EVENT, RunMove, Store, StoredDraft, StoredRoutine, StoredRun, StoredRunResult, StoredVersion, Tx,
};
use eos_domain::routine::blueprint::{Readable, canonical_json, hash, read};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::Trust;
use serde_json::{Value, json};

pub const PR_REVIEW: &str = "rt-sample000001";
pub const MORNING_PAPER: &str = "rt-sample000002";
pub const RELEASE_NOTES: &str = "rt-sample000003";
/// PR Review's first version, solo, and its head, the team.
pub const PR_REVIEW_FIRST: &str = "rv-sample000001";
pub const PR_REVIEW_HEAD: &str = "rv-sample000002";
const MORNING_PAPER_HEAD: &str = "rv-sample000003";
const RELEASE_NOTES_DRAFT: &str = "rv-sample000004";
/// PR Review's runs: shown, failed, found nothing, a trial.
pub const RUN_SHOWN: &str = "rn-sample000001";
pub const RUN_FAILED: &str = "rn-sample000002";
pub const RUN_NOTHING: &str = "rn-sample000003";
pub const RUN_TRIAL: &str = "rn-sample000004";

/// 2026-11-18 09:46:40 UTC: the sample day.
pub const BASE_MS: i64 = 1_795_000_000_000;
pub(crate) const MINUTE: i64 = 60_000;
pub(crate) const DAY: i64 = 24 * 60 * MINUTE;
/// The day the sample spend is booked on.
pub const SPEND_DAY: &str = "2026-11-18";
pub(crate) const DEVICE: &str = "sample-mac";

pub(crate) fn agent(key: &str, name: &str, lead: bool, reads_outside: bool, workspace: &str) -> Value {
    json!({"key": key, "name": name, "lead": lead, "brief": format!("You are the {name}."), "model": "sonnet",
           "effort": "medium", "tools": {}, "readsOutside": reads_outside, "workspace": workspace})
}

fn pr_review(team: bool) -> Value {
    let (depth, agents) = if team {
        (
            "team",
            json!([
                agent("lead", "Lead reviewer", true, false, "read"),
                agent("security", "Security reader", false, true, "read")
            ]),
        )
    } else {
        ("solo", json!([agent("reviewer", "Reviewer", true, false, "read")]))
    };
    json!({
        "format": 1, "name": "PR Review", "summary": "Reviews a pull request and drafts the review.",
        "icon": "eye", "aliases": ["review", "pr"], "kind": "standing",
        "takes": {"kind": "github.pull_request", "source": "github.pulls", "label": "pull request",
                  "placeholder": "#470", "empty": "required", "many": true},
        "options": [{"key": "depth", "label": "Depth", "type": "choice", "values": ["quick", "deep"],
                     "default": "quick", "inline": true}],
        "when": {"on": [{"source": "github.pulls", "scope": {"repo": "acme/game"}, "events": ["opened"]}]},
        "which": {},
        "who": {"depth": depth, "agents": agents, "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [{"key": "cites", "text": "Every comment names a line."}], "format": "review",
                "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [{"id": "pr", "kind": "item_place", "channel": "github",
                    "bound": {"fact": "repo", "in": ["acme/game"]}}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 2, "perRunMinutes": 30, "perDayUsd": 5, "parallel": 1},
        "needs": ["github"],
    })
}

fn morning_paper() -> Value {
    json!({
        "format": 1, "name": "Morning Paper", "summary": "A page of what changed overnight.", "icon": "news",
        "kind": "standing",
        "takes": {"kind": "none", "label": "nothing", "placeholder": "", "empty": "none", "many": false},
        "when": {"on": [{"schedule": {"daily": "07:00", "days": "weekdays", "zone": "Europe/Istanbul"}}]},
        "which": {},
        "who": {"depth": "solo", "agents": [agent("writer", "Writer", true, false, "none")],
                "checker": {"model": "sonnet", "effort": "low"}},
        "how": {"checks": [], "format": "page", "checkAgent": false},
        "makes": {"kind": "page", "description": "One page."},
        "goesTo": [{"id": "me", "kind": "me", "channel": "notify"}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 1, "perRunMinutes": 15, "perDayUsd": 2, "parallel": 1},
    })
}

fn release_notes() -> Value {
    json!({
        "format": 1, "name": "Release Notes", "summary": "Notes from the merged pull requests.", "icon": "doc",
        "kind": "standing",
        "takes": {"kind": "git.tag", "label": "release", "placeholder": "v1.2.0", "empty": "latest", "many": false},
        "when": {"on": []},
        "which": {},
        "who": {"depth": "solo", "agents": [agent("writer", "Writer", true, false, "read")],
                "checker": {"model": "sonnet", "effort": "low"}},
        "how": {"checks": [], "format": "notes", "checkAgent": false},
        "makes": {"kind": "text", "description": "Release notes."},
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 1, "perRunMinutes": 20, "perDayUsd": 3, "parallel": 1},
    })
}

/// A version of `blueprint` as this app stores it.
pub(crate) fn version(
    id: &str,
    routine_id: &str,
    parent: Option<&str>,
    author: VersionAuthor,
    blueprint: &Value,
) -> StoredVersion {
    let Ok(Readable::Current(typed)) = read(blueprint) else { panic!("a sample blueprint this app reads") };
    let text = canonical_json(&typed);
    let (status, trust) = match author {
        VersionAuthor::Architect => (VersionStatus::Draft, Trust::Trusted),
        _ if typed.takes.source.is_some() => (VersionStatus::Kept, Trust::Untrusted),
        _ => (VersionStatus::Kept, Trust::Trusted),
    };
    let created_at = match parent {
        Some(_) => BASE_MS - 2 * DAY,
        None => BASE_MS - 10 * DAY,
    };
    StoredVersion {
        id: id.to_owned(),
        routine_id: routine_id.to_owned(),
        parent_id: parent.map(str::to_owned),
        status,
        author,
        note: parent.map(|_| "A security reader joins the review.".to_owned()),
        format: typed.format,
        hash: hash(&text),
        blueprint: text,
        no_trial: false,
        trust,
        device: Some(DEVICE.to_owned()),
        created_at,
    }
}

pub(crate) fn routine(id: &str, name: &str, state: RoutineState, head: Option<&str>, origin: &str) -> StoredRoutine {
    StoredRoutine {
        id: id.to_owned(),
        slug: eos_domain::routine::slug::of_name(name),
        name: name.to_owned(),
        kind: RoutineKind::Standing,
        state,
        paused_reason: (state == RoutineState::Paused).then(|| "failures".to_owned()),
        head_version_id: head.map(str::to_owned),
        origin: origin.to_owned(),
        task_key: None,
        agents_may_start: false,
        failure_streak: if state == RoutineState::Paused { 3 } else { 0 },
        created_at: BASE_MS - 10 * DAY,
        updated_at: BASE_MS - DAY,
        changed_at: BASE_MS - DAY,
        started_at: (state != RoutineState::Draft).then_some(BASE_MS - 10 * DAY),
        deleted_at: None,
    }
}

/// One finished run of PR Review: its row, then each move of its timeline.
struct SampleRun {
    id: &'static str,
    kind: &'static str,
    origin: &'static str,
    number: u32,
    at: i64,
    moves: &'static [(RunState, Option<Station>, Option<Reason>)],
    outcome: Option<Outcome>,
    headline: &'static str,
    cost_usd: f64,
    work_ms: i64,
}

const DONE: &[(RunState, Option<Station>, Option<Reason>)] = &[
    (RunState::Running, Some(Station::Brief), None),
    (RunState::Running, Some(Station::Work), None),
    (RunState::Done, Some(Station::Gate), None),
];
const FAILED: &[(RunState, Option<Station>, Option<Reason>)] = &[
    (RunState::Running, Some(Station::Brief), None),
    (RunState::Running, Some(Station::Work), None),
    (RunState::Failed, Some(Station::Work), Some(Reason::NoResult)),
];
const NOTHING: &[(RunState, Option<Station>, Option<Reason>)] = &[
    (RunState::Running, Some(Station::Brief), None),
    (RunState::Running, Some(Station::Work), None),
    (RunState::Done, Some(Station::Work), None),
];

fn runs() -> [SampleRun; 4] {
    let run = |id, kind, origin, number, hours_ago: i64, moves, outcome, headline, cost_usd, minutes: i64| SampleRun {
        id,
        kind,
        origin,
        number,
        at: BASE_MS - hours_ago * 60 * MINUTE,
        moves,
        outcome,
        headline,
        cost_usd,
        work_ms: minutes * MINUTE,
    };
    [
        run(RUN_TRIAL, "trial", "trial", 455, 50, DONE, Some(Outcome::Shown), "Two notes on the cache", 0.42, 6),
        run(RUN_FAILED, "standing", "hand", 468, 3, FAILED, None, "The review missed the tests", 0.95, 14),
        run(RUN_NOTHING, "standing", "hand", 469, 2, NOTHING, Some(Outcome::Nothing), "Nothing to say", 0.18, 3),
        run(
            RUN_SHOWN,
            "standing",
            "hand",
            470,
            1,
            DONE,
            Some(Outcome::Shown),
            "Three comments on the login fix",
            0.61,
            8,
        ),
    ]
}

fn input(number: u32) -> String {
    let item = json!({"kind": "github.pull_request", "key": format!("github:pr:acme/game#{number}"),
                      "title": format!("Pull request #{number}"), "version": "abc1234", "untrusted": true});
    let input: RunInput = serde_json::from_value(json!({"item": item, "result": "usual"})).expect("an input");
    serde_json::to_string(&input).expect("JSON")
}

fn review(headline: &str) -> String {
    let doc = json!({"kind": "github.review", "channel": "github", "action": "post_review", "parts": [
        {"key": "summary", "role": "summary", "text": headline},
        {"key": "c:1", "role": "comment", "text": "This branch returns before the session is saved.",
         "meta": {"path": "src/login.rs", "line": 42, "side": "RIGHT"}},
    ]});
    doc.to_string()
}

fn write_run(tx: &dyn Tx, sample: &SampleRun) -> Result<(), Error> {
    let version = if sample.kind == "trial" { PR_REVIEW_FIRST } else { PR_REVIEW_HEAD };
    tx.runs().insert(&StoredRun {
        id: sample.id.to_owned(),
        routine_id: PR_REVIEW.to_owned(),
        version_id: Some(version.to_owned()),
        kind: sample.kind.to_owned(),
        origin: sample.origin.to_owned(),
        origin_ref: None,
        door: Some("routine_page".to_owned()),
        input: input(sample.number),
        item_key: Some(format!("github:pr:acme/game#{}", sample.number)),
        state: RunState::Queued,
        station: None,
        reason: None,
        attempt: 1,
        resumed: 0,
        not_before: None,
        priority: 0,
        progress_done: None,
        progress_total: None,
        headline: Some(sample.headline.to_owned()),
        outcome: None,
        cost_usd: 0.0,
        work_ms: 0,
        lead_id: None,
        device: DEVICE.to_owned(),
        remote: false,
        created_at: sample.at,
        started_at: None,
        ended_at: None,
        updated_at: sample.at,
    })?;
    tx.runs().append_event(sample.id, sample.at, RUN_STATE_EVENT, Some(r#"{"state":"queued"}"#))?;
    let step = sample.work_ms / sample.moves.len() as i64;
    for (i, (state, station, reason)) in sample.moves.iter().enumerate() {
        let at = sample.at + MINUTE + i as i64 * step;
        // The result is handed in as the run leaves work for the gate.
        if *station == Some(Station::Gate) {
            tx.run_results().insert(&StoredRunResult {
                run_id: sample.id.to_owned(),
                attempt: 1,
                kind: "github.review".to_owned(),
                headline: sample.headline.to_owned(),
                body: review(sample.headline),
                files: None,
                verdict: None,
                created_at: at,
            })?;
        }
        tx.runs().move_to(sample.id, &RunMove { state: *state, station: *station, reason: *reason, at })?;
    }
    if let Some(outcome) = sample.outcome {
        tx.runs().set_outcome(sample.id, outcome)?;
    }
    tx.runs().set_spent(sample.id, sample.cost_usd, sample.work_ms)
}

fn write(tx: &dyn Tx) -> Result<bool, Error> {
    if tx.routines().find(PR_REVIEW)?.is_some() {
        return Ok(false);
    }
    tx.routines().insert(&routine(PR_REVIEW, "PR Review", RoutineState::Active, Some(PR_REVIEW_HEAD), "hand"))?;
    tx.routine_versions().insert(&version(PR_REVIEW_FIRST, PR_REVIEW, None, VersionAuthor::User, &pr_review(false)))?;
    let head = version(PR_REVIEW_HEAD, PR_REVIEW, Some(PR_REVIEW_FIRST), VersionAuthor::User, &pr_review(true));
    tx.routine_versions().insert(&head)?;

    let paper = routine(MORNING_PAPER, "Morning Paper", RoutineState::Paused, Some(MORNING_PAPER_HEAD), "hand");
    tx.routines().insert(&paper)?;
    tx.routine_versions().insert(&version(
        MORNING_PAPER_HEAD,
        MORNING_PAPER,
        None,
        VersionAuthor::User,
        &morning_paper(),
    ))?;

    tx.routines().insert(&routine(RELEASE_NOTES, "Release Notes", RoutineState::Draft, None, "architect"))?;
    let draft = version(RELEASE_NOTES_DRAFT, RELEASE_NOTES, None, VersionAuthor::Architect, &release_notes());
    tx.routine_versions().insert(&draft)?;
    tx.routines().insert_draft(&StoredDraft {
        routine_id: RELEASE_NOTES.to_owned(),
        purpose: "Write release notes from the merged pull requests.".to_owned(),
        architect_id: None,
        base_version_id: None,
        draft_version_id: Some(RELEASE_NOTES_DRAFT.to_owned()),
        question: None,
        status: DraftStatus::Working,
        created_at: BASE_MS - DAY,
        updated_at: BASE_MS - DAY,
    })?;

    let runs = runs();
    for sample in &runs {
        write_run(tx, sample)?;
    }
    // The day's spend: the runs of that day, the trial the day before, the architect's setup.
    for sample in runs.iter().filter(|sample| sample.kind != "trial") {
        tx.routine_spend().add(SPEND_DAY, PR_REVIEW, "run", sample.cost_usd)?;
    }
    tx.routine_spend().add(SPEND_DAY, RELEASE_NOTES, "architect", 0.12)?;
    Ok(true)
}

/// Writes the sample routines, in one write. False when they are there
/// already: nothing is written then.
pub async fn seed(store: &dyn Store) -> Result<bool, Error> {
    store.write(|tx, _| write(tx)).await
}

#[cfg(test)]
mod tests {
    use eos_domain::routine::blueprint::{Context, Severity, validate};

    use super::*;

    #[test]
    fn every_sample_blueprint_meets_the_rules() {
        for (routine, blueprint) in [
            (PR_REVIEW, pr_review(false)),
            (PR_REVIEW, pr_review(true)),
            (MORNING_PAPER, morning_paper()),
            (RELEASE_NOTES, release_notes()),
        ] {
            let Ok(Readable::Current(typed)) = read(&blueprint) else { panic!("{routine} reads") };
            let context = Context { routine, chains: &[], known_zone: &|_| true, data_dir: None };
            let errors: Vec<_> =
                validate(&typed, &context).into_iter().filter(|issue| issue.severity == Severity::Error).collect();
            assert!(errors.is_empty(), "{routine}: {errors:?}");
        }
    }

    #[tokio::test]
    async fn the_seed_is_written_once() {
        let temp = crate::TempStore::new();
        assert!(seed(temp.port().as_ref()).await.expect("seeds"));
        assert!(!seed(temp.port().as_ref()).await.expect("seeds again"), "its ids are there");
        assert_eq!(temp.count("SELECT count(*) FROM routines"), 3);
        assert_eq!(temp.count("SELECT count(*) FROM runs"), 4);
        assert_eq!(temp.count("SELECT count(*) FROM routine_versions"), 4);
    }
}
