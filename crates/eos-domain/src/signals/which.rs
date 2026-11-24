//! The Which slot's rules: which items a routine takes. Rules test the facts
//! a source gives about an item. A fact the source could not read leaves the
//! item undecided, never unmatched: nobody can say it would have failed.

use eos_contracts::{Fact, Facts, Issues, Op, Rule, Which};

use super::glob;

/// At most this many tests in one rule.
pub const TESTS_MAX: usize = 32;
/// A rule nests at most this deep: `all` › `not` › a test is three.
pub const DEPTH_MAX: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    /// The test that failed, counted from 0 in reading order: for `any` its
    /// first test that failed, for `not` its first test.
    Fail(usize),
    /// The first fact the rule needed and the facts lack.
    Missing(String),
}

/// Checks a Which slot: its rule, and that a question says something.
pub fn validate(which: &Which, cx: &mut Issues) {
    if let Some(rule) = &which.rule {
        cx.at("rule", |cx| validate_rule(rule, cx));
    }
    if let Some(ask) = &which.ask {
        cx.at("ask", |cx| cx.str_min(ask.trim(), 1));
    }
}

/// Checks a rule wherever it sits (Which, a Freedom grant, a recipient's
/// bound): its size, depth and tests.
pub fn validate_rule(rule: &Rule, cx: &mut Issues) {
    if test_count(rule) > TESTS_MAX {
        cx.push(format!("A rule holds at most {TESTS_MAX} tests"));
    }
    rule_issues(rule, 1, cx);
}

fn rule_issues(rule: &Rule, depth: usize, cx: &mut Issues) {
    if depth > DEPTH_MAX {
        cx.push(format!("A rule nests at most {DEPTH_MAX} deep"));
        return;
    }
    let parts = |rules: &[Rule], cx: &mut Issues| {
        cx.arr_min(rules.len(), 1);
        for (i, rule) in rules.iter().enumerate() {
            cx.idx(i, |cx| rule_issues(rule, depth + 1, cx));
        }
    };
    match rule {
        Rule::All { all, .. } => cx.at("all", |cx| parts(all, cx)),
        Rule::Any { any, .. } => cx.at("any", |cx| parts(any, cx)),
        Rule::Not { not, .. } => cx.at("not", |cx| rule_issues(not, depth + 1, cx)),
        Rule::Test { fact, op, .. } => {
            cx.at("fact", |cx| cx.str_min(fact, 1));
            match op {
                Op::In(values) => cx.at("in", |cx| cx.arr_min(values.len(), 1)),
                Op::Has(item) => cx.at("has", |cx| cx.str_min(item, 1)),
                Op::Glob(pattern) => cx.at("glob", |cx| cx.str_min(pattern, 1)),
                Op::Contains(part) => cx.at("contains", |cx| cx.str_min(part, 1)),
                Op::Is(_) | Op::Gte(_) | Op::Lte(_) => {}
            }
        }
    }
}

fn test_count(rule: &Rule) -> usize {
    match rule {
        Rule::All { all: rules, .. } | Rule::Any { any: rules, .. } => rules.iter().map(test_count).sum(),
        Rule::Not { not, .. } => test_count(not),
        Rule::Test { .. } => 1,
    }
}

/// The facts `rule` tests, in reading order.
pub fn facts_tested(rule: &Rule) -> Vec<&str> {
    match rule {
        Rule::All { all: rules, .. } | Rule::Any { any: rules, .. } => rules.iter().flat_map(facts_tested).collect(),
        Rule::Not { not, .. } => facts_tested(not),
        Rule::Test { fact, .. } => vec![fact.as_str()],
    }
}

/// Whether an item's facts pass `rule`.
pub fn evaluate(rule: &Rule, facts: &Facts) -> Verdict {
    verdict(rule, facts, 0)
}

/// `first` is the number of the rule's first test.
fn verdict(rule: &Rule, facts: &Facts, first: usize) -> Verdict {
    match rule {
        Rule::All { all, .. } => combine(all, facts, first, true),
        Rule::Any { any, .. } => combine(any, facts, first, false),
        Rule::Not { not, .. } => match verdict(not, facts, first) {
            Verdict::Pass => Verdict::Fail(first),
            Verdict::Fail(_) => Verdict::Pass,
            missing @ Verdict::Missing(_) => missing,
        },
        Rule::Test { fact, op, .. } => match facts.get(fact) {
            None => Verdict::Missing(fact.clone()),
            Some(value) if holds(op, value) => Verdict::Pass,
            Some(_) => Verdict::Fail(first),
        },
    }
}

/// `all` fails on one part that fails and `any` passes on one that passes,
/// whatever the facts lack; otherwise a missing fact decides.
fn combine(rules: &[Rule], facts: &Facts, first: usize, all: bool) -> Verdict {
    let (mut at, mut missing, mut failed) = (first, None, None);
    for rule in rules {
        match verdict(rule, facts, at) {
            Verdict::Fail(test) if all => return Verdict::Fail(test),
            Verdict::Pass if !all => return Verdict::Pass,
            Verdict::Fail(test) => {
                failed.get_or_insert(test);
            }
            Verdict::Missing(fact) => {
                missing.get_or_insert(fact);
            }
            Verdict::Pass => {}
        }
        at += test_count(rule);
    }
    match missing {
        Some(fact) => Verdict::Missing(fact),
        None if all => Verdict::Pass,
        None => Verdict::Fail(failed.unwrap_or(first)),
    }
}

fn holds(op: &Op, value: &Fact) -> bool {
    // Text tests read a list as its items: one item that passes is enough.
    let any_text = |test: &dyn Fn(&str) -> bool| match value {
        Fact::Text(text) => test(text),
        Fact::List(items) => items.iter().any(|item| test(item)),
        Fact::Bool(_) | Fact::Number(_) => false,
    };
    match op {
        Op::Is(expected) => value == expected,
        Op::In(values) => any_text(&|text| values.iter().any(|v| v == text)),
        Op::Has(item) => matches!(value, Fact::List(items) if items.contains(item)),
        Op::Glob(pattern) => any_text(&|text| glob::matches(pattern, text)),
        Op::Contains(part) => {
            let part = part.to_lowercase();
            any_text(&|text| text.to_lowercase().contains(&part))
        }
        Op::Gte(bound) => matches!(value, Fact::Number(n) if n.0 >= bound.0),
        Op::Lte(bound) => matches!(value, Fact::Number(n) if n.0 <= bound.0),
    }
}

#[cfg(test)]
mod tests;
