//! A fragment's `when` against a session's facts.
//!
//! A leaf names one fact and at most one operator; the first present of
//! `eq`, `ne`, `in`, `nin`, `exists`, `truthy` decides, and a leaf with none
//! asks "is the fact truthy". The operator set is closed on purpose: richer
//! logic belongs in a fact computed before the prompt is assembled.

use eos_contracts::{Condition, ConditionLeaf};
use serde_json::{Map, Value};

use crate::template::is_truthy;

/// JavaScript's `===` between a fact and a value from the frontmatter: equal
/// primitives are equal, a list or an object equals nothing, and a fact that
/// is not there equals nothing.
fn strict_eq(fact: Option<&Value>, value: &Value) -> bool {
    match (fact, value) {
        (Some(Value::Null), Value::Null) => true,
        (Some(Value::Bool(a)), Value::Bool(b)) => a == b,
        (Some(Value::String(a)), Value::String(b)) => a == b,
        (Some(Value::Number(a)), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}

fn evaluate_leaf(leaf: &ConditionLeaf, facts: &Map<String, Value>) -> bool {
    let fact = facts.get(&leaf.fact);
    if let Some(value) = &leaf.eq {
        strict_eq(fact, value)
    } else if let Some(value) = &leaf.ne {
        !strict_eq(fact, value)
    } else if let Some(values) = &leaf.r#in {
        values.iter().any(|value| strict_eq(fact, value))
    } else if let Some(values) = &leaf.nin {
        !values.iter().any(|value| strict_eq(fact, value))
    } else if let Some(exists) = leaf.exists {
        fact.is_some_and(|value| !value.is_null()) == exists
    } else if let Some(truthy) = leaf.truthy {
        is_truthy(fact) == truthy
    } else {
        is_truthy(fact)
    }
}

/// Whether `condition` holds for `facts`.
pub fn evaluate_condition(condition: &Condition, facts: &Map<String, Value>) -> bool {
    match condition {
        Condition::All { all } => all.iter().all(|c| evaluate_condition(c, facts)),
        Condition::Any { any } => any.iter().any(|c| evaluate_condition(c, facts)),
        Condition::Not { not } => !evaluate_condition(not, facts),
        Condition::Leaf(leaf) => evaluate_leaf(leaf, facts),
    }
}
