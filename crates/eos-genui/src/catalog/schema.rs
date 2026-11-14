//! The slice of Zod the entity, row, source and action schemas use, with Zod's
//! own rules for which issues are raised, in which order, and what a union
//! reports. The TypeScript validator turns Zod issues into the problems a model
//! reads, so issue order and content have to be Zod's, not merely equivalent.
//!
//! The rules that matter:
//! - a wrong type aborts a schema; a failed check (length, range, pattern) only
//!   dirties it, and later checks still run;
//! - an object or array aborts when any member aborts, else is dirty when any
//!   member is dirty; members are all read either way;
//! - a union returns its first valid option; else the issues of its first dirty
//!   option; else one `invalid_union` issue;
//! - a refinement runs unless its inner schema aborted.

use std::sync::LazyLock;

use regress::Regex;

use crate::js;
use crate::value::Value;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Segment {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Code {
    InvalidType,
    InvalidLiteral,
    InvalidUnion,
    InvalidUnionDiscriminator,
    InvalidEnumValue,
    InvalidString,
    TooSmall,
    TooBig,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sized {
    String,
    Number,
    Array,
}

#[derive(Debug, Clone)]
pub(crate) struct Issue {
    pub(crate) code: Code,
    pub(crate) path: Vec<Segment>,
    pub(crate) message: String,
    /// `invalid_type` / `invalid_literal`: what was expected.
    pub(crate) expected: String,
    /// `invalid_type`: the type that arrived ("undefined" for a missing value).
    pub(crate) received: &'static str,
    /// `invalid_enum_value` / `invalid_union_discriminator`: the accepted values.
    pub(crate) options: &'static [&'static str],
    /// `too_small` / `too_big`: the bound, and what it bounds.
    pub(crate) bound: f64,
    pub(crate) sized: Sized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Valid,
    Dirty,
    Aborted,
}

pub(crate) type Pattern = &'static LazyLock<Regex>;

#[derive(Debug)]
pub(crate) enum StrCheck {
    Min(usize, Option<&'static str>),
    Max(usize, Option<String>),
    Matches(Pattern, &'static str),
}

#[derive(Debug)]
pub(crate) enum NumCheck {
    Int(Option<&'static str>),
    Min(f64, Option<&'static str>),
    Max(f64, Option<&'static str>),
}

#[derive(Debug)]
pub(crate) enum Schema {
    Str(Vec<StrCheck>),
    Num(Vec<NumCheck>),
    Bool,
    Literal(&'static str),
    Enum(&'static [&'static str]),
    Array {
        item: Box<Schema>,
        max: Option<usize>,
    },
    /// A fixed-length list; `message` replaces Zod's own for a wrong type or length.
    Tuple {
        items: Vec<Schema>,
        message: &'static str,
    },
    /// Unknown keys are never an issue here (the schemas pass them through or strip them).
    Object(Vec<(&'static str, Schema)>),
    Optional(Box<Schema>),
    /// A union whose failure reads as `message`.
    OneOf {
        options: Vec<Schema>,
        message: &'static str,
    },
    Record(Box<Schema>),
    Refine {
        inner: Box<Schema>,
        check: fn(&Value) -> bool,
        message: &'static str,
    },
    Discriminated {
        key: &'static str,
        options: Vec<(&'static str, Schema)>,
    },
    Unknown,
}

impl Schema {
    pub(crate) fn optional(self) -> Schema {
        Schema::Optional(Box::new(self))
    }

    /// `safeParse`: the issues, empty when the value is accepted.
    pub(crate) fn check(&self, value: Option<&Value>) -> Vec<Issue> {
        let mut issues = Vec::new();
        self.parse(value, &mut Vec::new(), &mut issues);
        issues
    }

    fn parse(&self, value: Option<&Value>, path: &mut Vec<Segment>, issues: &mut Vec<Issue>) -> Status {
        let mut cx = Cx { path, issues };
        match self {
            Schema::Unknown => Status::Valid,
            Schema::Optional(inner) => match value {
                None => Status::Valid,
                Some(_) => inner.parse(value, cx.path, cx.issues),
            },
            Schema::Str(checks) => {
                let Some(Value::String(s)) = value else { return cx.wrong_type("string", value) };
                let len = js::len16(s);
                let mut status = Status::Valid;
                for check in checks {
                    let failed = match check {
                        StrCheck::Min(min, message) if len < *min => {
                            let message = message.map_or_else(
                                || format!("String must contain at least {min} character(s)"),
                                str::to_owned,
                            );
                            Some(cx.sized(Code::TooSmall, *min as f64, Sized::String, message))
                        }
                        StrCheck::Max(max, message) if len > *max => {
                            let message = message
                                .clone()
                                .unwrap_or_else(|| format!("String must contain at most {max} character(s)"));
                            Some(cx.sized(Code::TooBig, *max as f64, Sized::String, message))
                        }
                        StrCheck::Matches(re, message) if re.find(s).is_none() => {
                            Some(cx.issue(Code::InvalidString, (*message).to_owned()))
                        }
                        _ => None,
                    };
                    if let Some(issue) = failed {
                        cx.issues.push(issue);
                        status = Status::Dirty;
                    }
                }
                status
            }
            Schema::Num(checks) => {
                let Some(Value::Number(n)) = value else { return cx.wrong_type("number", value) };
                let n = *n;
                let mut status = Status::Valid;
                for check in checks {
                    let failed = match check {
                        NumCheck::Int(message) if n.fract() != 0.0 || !n.is_finite() => Some(Issue {
                            expected: "integer".to_owned(),
                            received: "float",
                            ..cx.issue(
                                Code::InvalidType,
                                message.unwrap_or("Expected integer, received float").to_owned(),
                            )
                        }),
                        NumCheck::Min(min, message) if n < *min => {
                            let message = message.map_or_else(
                                || format!("Number must be greater than or equal to {}", js::number_to_string(*min)),
                                str::to_owned,
                            );
                            Some(cx.sized(Code::TooSmall, *min, Sized::Number, message))
                        }
                        NumCheck::Max(max, message) if n > *max => {
                            let message = message.map_or_else(
                                || format!("Number must be less than or equal to {}", js::number_to_string(*max)),
                                str::to_owned,
                            );
                            Some(cx.sized(Code::TooBig, *max, Sized::Number, message))
                        }
                        _ => None,
                    };
                    if let Some(issue) = failed {
                        cx.issues.push(issue);
                        status = Status::Dirty;
                    }
                }
                status
            }
            Schema::Bool => match value {
                Some(Value::Bool(_)) => Status::Valid,
                _ => cx.wrong_type("boolean", value),
            },
            Schema::Literal(expected) => {
                if value.and_then(Value::as_str) == Some(*expected) {
                    return Status::Valid;
                }
                let issue = Issue {
                    expected: (*expected).to_owned(),
                    ..cx.issue(Code::InvalidLiteral, format!("Invalid literal value, expected {}", js::quote(expected)))
                };
                cx.abort(issue)
            }
            Schema::Enum(options) => {
                let Some(Value::String(s)) = value else { return cx.wrong_type(&join_values(options), value) };
                if options.contains(&s.as_str()) {
                    return Status::Valid;
                }
                let message = format!("Invalid enum value. Expected {}, received '{s}'", join_values(options));
                let issue = Issue { options, ..cx.issue(Code::InvalidEnumValue, message) };
                cx.abort(issue)
            }
            Schema::Array { item, max } => {
                let Some(Value::Array(items)) = value else { return cx.wrong_type("array", value) };
                let mut status = Status::Valid;
                if let Some(max) = max.filter(|max| items.len() > *max) {
                    let issue = cx.sized(
                        Code::TooBig,
                        max as f64,
                        Sized::Array,
                        format!("Array must contain at most {max} element(s)"),
                    );
                    cx.issues.push(issue);
                    status = Status::Dirty;
                }
                cx.members(status, items.iter().enumerate().map(|(i, v)| (Segment::Index(i), item.as_ref(), Some(v))))
            }
            Schema::Tuple { items: schemas, message } => {
                let Some(Value::Array(items)) = value else {
                    let issue = Issue { message: (*message).to_owned(), ..cx.type_issue("array", value) };
                    return cx.abort(issue);
                };
                if items.len() < schemas.len() {
                    let issue = cx.sized(Code::TooSmall, schemas.len() as f64, Sized::Array, (*message).to_owned());
                    return cx.abort(issue);
                }
                let mut status = Status::Valid;
                if items.len() > schemas.len() {
                    let issue = cx.sized(Code::TooBig, schemas.len() as f64, Sized::Array, (*message).to_owned());
                    cx.issues.push(issue);
                    status = Status::Dirty;
                }
                cx.members(
                    status,
                    schemas.iter().zip(items).enumerate().map(|(i, (schema, v))| (Segment::Index(i), schema, Some(v))),
                )
            }
            Schema::Object(fields) => {
                let Some(Value::Object(o)) = value else { return cx.wrong_type("object", value) };
                cx.members(
                    Status::Valid,
                    fields.iter().map(|(key, schema)| (Segment::Key((*key).to_owned()), schema, o.get(key))),
                )
            }
            Schema::Record(item) => {
                let Some(Value::Object(o)) = value else { return cx.wrong_type("object", value) };
                cx.members(
                    Status::Valid,
                    o.iter().map(|(key, v)| (Segment::Key(key.to_owned()), item.as_ref(), Some(v))),
                )
            }
            Schema::OneOf { options, message } => {
                let mut dirty: Option<Vec<Issue>> = None;
                for option in options {
                    let mut own = Vec::new();
                    match option.parse(value, cx.path, &mut own) {
                        Status::Valid => return Status::Valid,
                        Status::Dirty if dirty.is_none() => dirty = Some(own),
                        _ => {}
                    }
                }
                if let Some(own) = dirty {
                    cx.issues.extend(own);
                    return Status::Dirty;
                }
                let issue = cx.issue(Code::InvalidUnion, (*message).to_owned());
                cx.abort(issue)
            }
            Schema::Refine { inner, check, message } => {
                let status = inner.parse(value, cx.path, cx.issues);
                if status == Status::Aborted {
                    return status;
                }
                if value.is_some_and(check) {
                    return status;
                }
                let issue = cx.issue(Code::Custom, (*message).to_owned());
                cx.issues.push(issue);
                Status::Dirty
            }
            Schema::Discriminated { key, options } => {
                let Some(Value::Object(o)) = value else { return cx.wrong_type("object", value) };
                let tag = o.get(key).and_then(Value::as_str);
                match options.iter().find(|(name, _)| Some(*name) == tag) {
                    Some((_, schema)) => schema.parse(value, cx.path, cx.issues),
                    None => {
                        cx.path.push(Segment::Key((*key).to_owned()));
                        let names: Vec<&str> = options.iter().map(|(name, _)| *name).collect();
                        let issue = cx.issue(
                            Code::InvalidUnionDiscriminator,
                            format!("Invalid discriminator value. Expected {}", join_values(&names)),
                        );
                        cx.path.pop();
                        cx.abort(issue)
                    }
                }
            }
        }
    }
}

struct Cx<'a> {
    path: &'a mut Vec<Segment>,
    issues: &'a mut Vec<Issue>,
}

impl Cx<'_> {
    fn issue(&self, code: Code, message: String) -> Issue {
        Issue {
            code,
            path: self.path.clone(),
            message,
            expected: String::new(),
            received: "",
            options: &[],
            bound: 0.0,
            sized: Sized::Number,
        }
    }

    fn sized(&self, code: Code, bound: f64, sized: Sized, message: String) -> Issue {
        Issue { bound, sized, ..self.issue(code, message) }
    }

    fn type_issue(&self, expected: &str, value: Option<&Value>) -> Issue {
        let received = type_name(value);
        let message =
            if value.is_none() { "Required".to_owned() } else { format!("Expected {expected}, received {received}") };
        Issue { expected: expected.to_owned(), received, ..self.issue(Code::InvalidType, message) }
    }

    fn wrong_type(&mut self, expected: &str, value: Option<&Value>) -> Status {
        let issue = self.type_issue(expected, value);
        self.abort(issue)
    }

    fn abort(&mut self, issue: Issue) -> Status {
        self.issues.push(issue);
        Status::Aborted
    }

    // Every member is read (its issues are wanted even when an earlier one aborted).
    fn members<'s, 'v>(
        &mut self,
        mut status: Status,
        members: impl Iterator<Item = (Segment, &'s Schema, Option<&'v Value>)>,
    ) -> Status {
        for (segment, schema, value) in members {
            self.path.push(segment);
            let member = schema.parse(value, self.path, self.issues);
            self.path.pop();
            status = match (status, member) {
                (Status::Aborted, _) | (_, Status::Aborted) => Status::Aborted,
                (Status::Dirty, _) | (_, Status::Dirty) => Status::Dirty,
                _ => Status::Valid,
            };
        }
        status
    }
}

/// Zod's name for the type of a value.
pub(crate) fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(n)) if n.is_nan() => "nan",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn join_values(values: &[&str]) -> String {
    values.iter().map(|v| format!("'{v}'")).collect::<Vec<_>>().join(" | ")
}
