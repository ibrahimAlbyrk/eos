//! Compares a recorded response with what a target answered, and prints where they part.

use std::fmt::Write as _;

use serde_json::Value;

/// One place where the two documents differ.
#[derive(Debug, Clone, PartialEq)]
pub struct Difference {
    /// JSON pointer into the response.
    pub path: String,
    /// `None`: the recording has nothing here.
    pub expected: Option<Value>,
    /// `None`: the target answered nothing here.
    pub actual: Option<Value>,
}

/// Every difference, in document order. Object key order does not count.
pub fn diff(expected: &Value, actual: &Value) -> Vec<Difference> {
    let mut out = Vec::new();
    compare(expected, actual, &mut String::new(), &mut out);
    out
}

fn compare(expected: &Value, actual: &Value, path: &mut String, out: &mut Vec<Difference>) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                descend(path, key, |path| match got.get(key) {
                    Some(other) => compare(value, other, path, out),
                    None => out.push(Difference { path: path.clone(), expected: Some(value.clone()), actual: None }),
                });
            }
            for (key, value) in got {
                if !want.contains_key(key) {
                    descend(path, key, |path| {
                        out.push(Difference { path: path.clone(), expected: None, actual: Some(value.clone()) });
                    });
                }
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            for index in 0..want.len().max(got.len()) {
                descend(path, &index.to_string(), |path| match (want.get(index), got.get(index)) {
                    (Some(a), Some(b)) => compare(a, b, path, out),
                    (a, b) => out.push(Difference { path: path.clone(), expected: a.cloned(), actual: b.cloned() }),
                });
            }
        }
        _ if expected == actual => {}
        _ => {
            out.push(Difference { path: path.clone(), expected: Some(expected.clone()), actual: Some(actual.clone()) })
        }
    }
}

fn descend(path: &mut String, segment: &str, f: impl FnOnce(&mut String)) {
    let len = path.len();
    path.push('/');
    path.push_str(&segment.replace('~', "~0").replace('/', "~1"));
    f(path);
    path.truncate(len);
}

/// What a replay found for one scenario.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub scenario: String,
    pub steps: Vec<StepReport>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepReport {
    pub step: String,
    /// `"METHOD /path"`, or what the step did to a stream.
    pub what: String,
    pub differences: Vec<Difference>,
}

impl Report {
    pub fn failed(&self) -> usize {
        self.steps.iter().filter(|s| !s.differences.is_empty()).count()
    }

    /// The readable form: one line per step that matches, the differing places under one that does not.
    pub fn render(&self, verbose: bool) -> String {
        let mut out = String::new();
        let failed = self.failed();
        let _ = writeln!(out, "{}: {} of {} steps match", self.scenario, self.steps.len() - failed, self.steps.len());
        for step in &self.steps {
            if step.differences.is_empty() {
                if verbose {
                    let _ = writeln!(out, "  ok    {:<28} {}", step.step, step.what);
                }
                continue;
            }
            let _ = writeln!(out, "  DIFF  {:<28} {}", step.step, step.what);
            for d in &step.differences {
                let place = if d.path.is_empty() { "/" } else { &d.path };
                let _ = match (&d.expected, &d.actual) {
                    (Some(want), Some(got)) => {
                        let (want, got) = around_the_difference(&want.to_string(), &got.to_string());
                        writeln!(out, "          {place}\n            recorded {want}\n            got      {got}")
                    }
                    (Some(want), None) => {
                        writeln!(out, "          {place}\n            missing; recorded {}", brief(want))
                    }
                    (None, Some(got)) => {
                        writeln!(out, "          {place}\n            not in the recording; got {}", brief(got))
                    }
                    (None, None) => Ok(()),
                };
            }
        }
        out
    }
}

const MAX: usize = 160;

fn brief(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() <= MAX {
        return text;
    }
    let cut: String = text.chars().take(MAX).collect();
    format!("{cut}… ({} chars)", text.chars().count())
}

/// Two long values usually differ in one place: show both from just before it.
fn around_the_difference(want: &str, got: &str) -> (String, String) {
    let (want_chars, got_chars): (Vec<char>, Vec<char>) = (want.chars().collect(), got.chars().collect());
    if want_chars.len() <= MAX && got_chars.len() <= MAX {
        return (want.to_owned(), got.to_owned());
    }
    let same = want_chars.iter().zip(&got_chars).take_while(|(a, b)| a == b).count();
    let from = same.saturating_sub(40);
    let window = |chars: &[char]| {
        let end = (from + MAX).min(chars.len());
        let head = if from > 0 { "…" } else { "" };
        let tail = if end < chars.len() { "…" } else { "" };
        format!("{head}{}{tail} ({} chars)", chars[from.min(end)..end].iter().collect::<String>(), chars.len())
    };
    (window(&want_chars), window(&got_chars))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn equal_documents_have_no_difference() {
        let doc = json!({"status": 200, "json": {"a": [1, {"b": null}]}});
        assert!(diff(&doc, &doc).is_empty());
    }

    #[test]
    fn finds_changed_missing_and_extra_places() {
        let want = json!({"status": 200, "json": {"name": "a", "tags": ["x", "y"], "gone": 1, "a/b": 1}});
        let got = json!({"status": 404, "json": {"name": "a", "tags": ["x"], "new": true, "a/b": 2}});
        assert_eq!(
            diff(&want, &got),
            vec![
                Difference { path: "/status".into(), expected: Some(json!(200)), actual: Some(json!(404)) },
                Difference { path: "/json/tags/1".into(), expected: Some(json!("y")), actual: None },
                Difference { path: "/json/gone".into(), expected: Some(json!(1)), actual: None },
                Difference { path: "/json/a~1b".into(), expected: Some(json!(1)), actual: Some(json!(2)) },
                Difference { path: "/json/new".into(), expected: None, actual: Some(json!(true)) },
            ]
        );
    }

    #[test]
    fn a_type_change_is_one_difference() {
        assert_eq!(
            diff(&json!({"json": {"a": 1}}), &json!({"json": [1]})),
            vec![Difference { path: "/json".into(), expected: Some(json!({"a": 1})), actual: Some(json!([1])) }]
        );
    }

    #[test]
    fn long_values_are_shown_around_where_they_part() {
        let prefix = "x".repeat(500);
        let (want, got) =
            around_the_difference(&format!("{prefix}durationMs:41,tail"), &format!("{prefix}durationMs:57,tail"));
        assert!(
            want.starts_with('…') && want.contains("durationMs:41,tail") && want.ends_with("(518 chars)"),
            "{want}"
        );
        assert!(got.contains("durationMs:57,tail"), "{got}");
        assert_eq!(around_the_difference("a", "b"), ("a".to_owned(), "b".to_owned()));
    }

    #[test]
    fn renders_a_report() {
        let report = Report {
            scenario: "pages".into(),
            steps: vec![
                StepReport { step: "list".into(), what: "GET /api/pages".into(), differences: vec![] },
                StepReport {
                    step: "create".into(),
                    what: "POST /api/pages".into(),
                    differences: diff(&json!({"status": 200, "json": {"a": 1}}), &json!({"status": 400})),
                },
            ],
        };
        assert_eq!(report.failed(), 1);
        let text = report.render(false);
        assert!(text.starts_with("pages: 1 of 2 steps match\n  DIFF  create"), "{text}");
        assert!(text.contains("/json\n            missing; recorded {\"a\":1}"), "{text}");
        assert!(text.contains("/status\n            recorded 200\n            got      400"), "{text}");
        assert!(!text.contains("list"));
        assert!(report.render(true).contains("  ok    list"));
    }
}
