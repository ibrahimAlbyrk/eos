//! The variables of the messages a loop's tick sends; the prose is in the
//! prompt library under `loop/` (`core/src/domain/loop-feedback.ts`).

use eos_contracts::{GoalSpec, GoalVerdict};
use serde_json::{Map, Value};

/// To the worker: the goal is not met yet, keep going.
pub const CONTINUATION: &str = "loop/continuation";
/// To the parent: the worker's report, wrapped with why the loop ended unmet.
pub const EXHAUSTED_RELEASE: &str = "loop/exhausted-release";
/// To the parent: the worker's report as unverified, with what to decide.
pub const ESCALATION: &str = "loop/escalation";
/// To the worker: the check itself failed, not the work.
pub const CHECK_ERROR: &str = "loop/check-error";
/// To the parent, for a worker that left no report: the goal is met.
pub const LOOP_COMPLETE: &str = "loop/loop-complete";
/// To the parent, for a worker that left no report: the loop ended unmet.
pub const LOOP_EXHAUSTED: &str = "loop/loop-exhausted";

/// Added, in the continuation, to an unmet criterion the gate cannot verify.
const UNVERIFIABLE_NOTE: &str = " — the gate cannot verify this criterion from its evidence; do NOT write artifacts \
                                 for it — it will be escalated once the remaining criteria pass";

/// The unmet criteria, a line each with the evidence of why; the bare ids when
/// the verdict has no row per criterion.
fn unmet_list(goal: &GoalSpec, verdict: &GoalVerdict, annotate_unverifiable: bool) -> String {
    let text_of = |id: &str| goal.criteria.iter().find(|c| c.id == id).map_or(id, |c| c.text.as_str()).to_owned();
    let lines: Vec<String> = verdict
        .criteria
        .iter()
        .filter(|c| !c.met)
        .map(|c| {
            let evidence = if c.evidence.is_empty() { String::new() } else { format!(" — {}", c.evidence) };
            let note = if annotate_unverifiable && c.unverifiable == Some(true) { UNVERIFIABLE_NOTE } else { "" };
            format!("- {}{evidence}{note}", text_of(&c.id))
        })
        .collect();
    if lines.is_empty() {
        verdict.unmet.iter().map(|id| format!("- {id}")).collect::<Vec<_>>().join("\n")
    } else {
        lines.join("\n")
    }
}

fn vars<const N: usize>(pairs: [(&str, String); N]) -> Map<String, Value> {
    pairs.into_iter().map(|(name, value)| (name.to_owned(), Value::String(value))).collect()
}

pub fn continuation_vars(goal: &GoalSpec, verdict: &GoalVerdict, attempt: i64) -> Map<String, Value> {
    vars([
        ("GOAL_SUMMARY", goal.summary.clone()),
        ("UNMET", unmet_list(goal, verdict, true)),
        ("ATTEMPT", attempt.to_string()),
    ])
}

pub fn exhausted_release_vars(
    goal: &GoalSpec,
    verdict: &GoalVerdict,
    reason: &str,
    report: &str,
) -> Map<String, Value> {
    vars([
        ("GOAL_SUMMARY", goal.summary.clone()),
        ("REASON", reason.to_owned()),
        ("UNMET", unmet_list(goal, verdict, false)),
        ("REPORT", report.to_owned()),
    ])
}

pub fn escalation_vars(goal: &GoalSpec, verdict: &GoalVerdict, reason: &str, report: &str) -> Map<String, Value> {
    exhausted_release_vars(goal, verdict, reason, report)
}

pub fn check_error_vars(goal: &GoalSpec) -> Map<String, Value> {
    vars([("GOAL_SUMMARY", goal.summary.clone())])
}

pub fn loop_complete_vars(goal: &GoalSpec, attempts: i64) -> Map<String, Value> {
    vars([("GOAL_SUMMARY", goal.summary.clone()), ("ATTEMPTS", attempts.to_string())])
}

pub fn loop_exhausted_vars(goal: &GoalSpec, verdict: &GoalVerdict, reason: &str, attempts: i64) -> Map<String, Value> {
    vars([
        ("REASON", reason.to_owned()),
        ("ATTEMPTS", attempts.to_string()),
        ("UNMET", unmet_list(goal, verdict, false)),
    ])
}

#[cfg(test)]
mod tests {
    use eos_contracts::{GoalSpecCriteriaItem, GoalVerdictCriteriaItem};

    use super::*;

    #[test]
    fn the_unmet_list_names_each_criterion_with_its_evidence() {
        let goal = GoalSpec {
            summary: "ship it".into(),
            criteria: vec![
                GoalSpecCriteriaItem { id: "c1".into(), text: "tests pass".into(), verify: Some("npm test".into()) },
                GoalSpecCriteriaItem { id: "c2".into(), text: "fast".into(), verify: None },
            ],
        };
        let row = |id: &str, met: bool, evidence: &str, unverifiable: Option<bool>| GoalVerdictCriteriaItem {
            id: id.into(),
            met,
            evidence: evidence.into(),
            unverifiable,
        };
        let verdict = GoalVerdict {
            met: false,
            criteria: vec![row("c1", false, "exit 1: npm test", None), row("c2", false, "", Some(true))],
            unmet: vec!["c1".into(), "c2".into()],
            confidence: 1.0.into(),
            reason: "unmet".into(),
            indeterminate: None,
        };
        let vars = continuation_vars(&goal, &verdict, 2);
        assert_eq!(vars["UNMET"], format!("- tests pass — exit 1: npm test\n- fast{UNVERIFIABLE_NOTE}"));
        assert_eq!(vars["ATTEMPT"], "2");
        let plain = exhausted_release_vars(&goal, &verdict, "why", "report");
        assert_eq!(plain["UNMET"], "- tests pass — exit 1: npm test\n- fast");
        let bare = GoalVerdict { criteria: vec![], ..verdict };
        assert_eq!(loop_exhausted_vars(&goal, &bare, "r", 3)["UNMET"], "- c1\n- c2");
    }
}
