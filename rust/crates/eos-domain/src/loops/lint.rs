//! A goal checked against its strategy when it is armed or amended
//! (`core/src/domain/loop-criteria-lint.ts`).

use std::sync::LazyLock;

use eos_contracts::{GoalSpec, GoalSpecCriteriaItem, LoopStrategy};
use regress::Regex;

/// A file the judge could grade from the diff and the named files: a slash
/// path (`src/game.ts`) or a dotted file name (`index.html`).
static PATH_TOKEN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"[\w.-]+\/[\w./-]+|\b[\w-]+\.[A-Za-z][\w-]*\b").ok());

fn is_verifyless(criterion: &GoalSpecCriteriaItem) -> bool {
    criterion.verify.as_deref().is_none_or(|v| v.trim().is_empty())
}

fn names_a_file(text: &str) -> bool {
    PATH_TOKEN.as_ref().is_some_and(|re| re.find(text).is_some())
}

/// The advisory warnings for a goal, or why it can never pass: a `command`
/// goal with a criterion that has no verify command (the command check skips
/// those). For `judge` and `hybrid`, a criterion with no verify that names no
/// file is warned about: the judge sees only the diff and named files for it.
pub fn lint_goal_criteria(strategy: LoopStrategy, goal: &GoalSpec) -> Result<Vec<String>, String> {
    let verifyless: Vec<&GoalSpecCriteriaItem> = goal.criteria.iter().filter(|c| is_verifyless(c)).collect();
    if strategy == LoopStrategy::Command && !verifyless.is_empty() {
        let ids = verifyless.iter().map(|c| c.id.as_str()).collect::<Vec<_>>().join(", ");
        let verb = if verifyless.len() == 1 { "has" } else { "have" };
        return Err(format!(
            "strategy \"command\" needs a verify on every criterion; {ids} {verb} none — the command gate skips \
             verify-less criteria, so this goal can never pass"
        ));
    }
    if strategy == LoopStrategy::Command {
        return Ok(Vec::new());
    }
    Ok(verifyless
        .into_iter()
        .filter(|c| !names_a_file(&c.text))
        .map(|c| {
            format!(
                "criterion \"{}\" has no verify and names no file path — the judge sees only the diff and named files \
                 for it and may never confirm runtime behavior; add a verify (smoke command) or name the artifact it \
                 produces",
                c.id
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(criteria: &[(&str, &str, Option<&str>)]) -> GoalSpec {
        GoalSpec {
            summary: "g".into(),
            criteria: criteria
                .iter()
                .map(|(id, text, verify)| GoalSpecCriteriaItem {
                    id: (*id).into(),
                    text: (*text).into(),
                    verify: verify.map(str::to_owned),
                })
                .collect(),
        }
    }

    // core/src/__tests__/attachLoop.test.ts, amendLoop.test.ts
    #[test]
    fn a_command_goal_needs_a_verify_everywhere_and_the_judge_wants_a_file() {
        let blank = goal(&[("c1", "tests pass", Some("npm test")), ("c2", "looks good", Some("  "))]);
        let refused = lint_goal_criteria(LoopStrategy::Command, &blank).expect_err("refused");
        assert!(refused.starts_with("strategy \"command\" needs a verify on every criterion; c2 has none"));
        assert_eq!(lint_goal_criteria(LoopStrategy::Command, &goal(&[("c1", "x", Some("true"))])), Ok(vec![]));

        let prose = goal(&[
            ("c1", "the page feels fast", None),
            ("c2", "src/game.ts exports run", None),
            ("c3", "index.html has a title", None),
        ]);
        let warnings = lint_goal_criteria(LoopStrategy::Hybrid, &prose).expect("armed");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].starts_with("criterion \"c1\" has no verify and names no file path"));
        assert_eq!(lint_goal_criteria(LoopStrategy::Judge, &prose).expect("armed").len(), 1);
    }
}
