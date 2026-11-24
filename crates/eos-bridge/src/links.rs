//! What an `eos://` link asks of the app (07 §4.3). A link opens the window at a place, fills
//! the run form or holds text for the quick panel; it never starts anything and never carries
//! a file. Anything outside the grammar opens the window and nothing more.
//!
//! A dev or test build answers the same links under `eos-dev://` (`launch::link_scheme`).

use eos_runtime::http::path::percent_decode;

use crate::urlspace::percent_encode;

/// The longest link read: a share's text or address arrives inside one.
pub const MAX_LINK: usize = 8 * 1024;
/// The longest value of one parameter.
const MAX_VALUE: usize = 4 * 1024;
/// The longest name: a routine, an option, a button, an id.
const MAX_NAME: usize = 64;

/// One link, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// An invite to pair with another computer: the whole link, as the Connect sheet reads it.
    Pair,
    /// Open the window at this location of the dashboard (`eos:/…`).
    Open(String),
    /// Open the window at an issue of its page. A button the link names runs only after the
    /// user confirms it there.
    Issue { id: String, button: Option<String>, index: Option<u32> },
    /// Hold this for the quick panel.
    Send(Sent),
    /// Open the window and nothing more: a sign-in's link back (the core reads it), or a link
    /// outside the grammar.
    Window,
}

/// What an `eos://send` link holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    Text(String),
    Url(String),
}

/// Reads a link. Never fails: a link it cannot read is [`Link::Window`].
pub fn parse(link: &str) -> Link {
    if link.len() > MAX_LINK {
        return Link::Window;
    }
    let Some(rest) = link.strip_prefix("eos://").or_else(|| link.strip_prefix("eos-dev://")) else {
        return Link::Window;
    };
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let Some(params) = params(query) else {
        return Link::Window;
    };
    let segments: Vec<&str> = path.split('/').collect();
    let read = match segments.as_slice() {
        ["pair", ..] => Some(Link::Pair),
        ["run", routine] => run(routine, &params),
        ["runs", id] if params.is_empty() && is_name(id) => Some(Link::Open(format!("eos:/runs/{id}"))),
        ["inbox"] if params.is_empty() => Some(Link::Open("eos:/needs".into())),
        ["inbox", id] if params.is_empty() && is_name(id) => Some(Link::Open(format!("eos:/needs/{id}"))),
        ["issue", id] => issue(id, &params),
        ["send"] => send(&params),
        _ => None,
    };
    read.unwrap_or(Link::Window)
}

/// The query's pairs, decoded as a form does (`+` is a space); `None` for a broken escape or a
/// value past the limit.
fn params(query: &str) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let decode = |s: &str| percent_decode(&s.replace('+', " ")).map(|c| c.into_owned());
        let (k, v) = (decode(k)?, decode(v)?);
        if v.len() > MAX_VALUE {
            return None;
        }
        out.push((k, v));
    }
    Some(out)
}

/// 1–64 characters of `[a-z0-9-]`.
fn is_name(s: &str) -> bool {
    (1..=MAX_NAME).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `eos://run/<routine>?item=&note=&opt.<name>=&show-only=1&at=` → the run form, marked as
/// coming from a link.
fn run(routine: &str, params: &[(String, String)]) -> Option<Link> {
    if !is_name(routine) {
        return None;
    }
    let mut route = format!("eos:/form?routine={routine}");
    let mut tail = String::new();
    for (k, v) in params {
        match k.as_str() {
            "item" | "note" | "at" => route.push_str(&format!("&{k}={}", percent_encode(v))),
            "show-only" if v == "1" => tail.push_str("&showOnly=1"),
            _ => match k.strip_prefix("opt.") {
                Some(name) if is_name(name) => route.push_str(&format!("&opt.{name}={}", percent_encode(v))),
                _ => return None,
            },
        }
    }
    Some(Link::Open(format!("{route}{tail}&from=link")))
}

/// `eos://issue/<issue-id>?button=&index=`.
fn issue(id: &str, params: &[(String, String)]) -> Option<Link> {
    if !is_name(id) {
        return None;
    }
    let (mut button, mut index) = (None, None);
    for (k, v) in params {
        match k.as_str() {
            "button" if is_name(v) => button = Some(v.clone()),
            "index" => index = Some(v.parse().ok()?),
            _ => return None,
        }
    }
    Some(Link::Issue { id: id.to_string(), button, index })
}

/// `eos://send?text=` or `eos://send?url=`: one of the two, not empty.
fn send(params: &[(String, String)]) -> Option<Link> {
    match params {
        [(k, v)] if k == "text" && !v.is_empty() => Some(Link::Send(Sent::Text(v.clone()))),
        [(k, v)] if k == "url" && (v.starts_with("https://") || v.starts_with("http://")) => {
            Some(Link::Send(Sent::Url(v.clone())))
        }
        _ => None,
    }
}

/// Where an issue opens once its page is known: the surface at that issue's number, with the
/// button the link named for the page to confirm.
pub fn issue_location(surface_id: &str, seq: Option<i64>, button: Option<&str>, index: Option<u32>) -> String {
    let mut route = format!("eos:/surfaces/{}", percent_encode(surface_id));
    let mut query = Vec::new();
    if let Some(seq) = seq {
        query.push(format!("issue={seq}"));
    }
    if let Some(button) = button {
        query.push(format!("button={button}"));
    }
    if let Some(index) = index {
        query.push(format!("index={index}"));
    }
    if !query.is_empty() {
        route.push('?');
        route.push_str(&query.join("&"));
    }
    route
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(route: &str) -> Link {
        Link::Open(route.into())
    }

    #[test]
    fn a_run_link_fills_the_form_and_marks_it_as_from_a_link() {
        assert_eq!(parse("eos://run/pr-review"), open("eos:/form?routine=pr-review&from=link"));
        assert_eq!(
            parse(
                "eos://run/pr-review?item=%23470&note=Check+the+tests&opt.depth=deep&show-only=1&at=2026-11-19T09%3A00"
            ),
            open(
                "eos:/form?routine=pr-review&item=%23470&note=Check%20the%20tests&opt.depth=deep&at=2026-11-19T09%3A00&showOnly=1&from=link"
            )
        );
        assert_eq!(
            parse("eos-dev://run/pr-review"),
            open("eos:/form?routine=pr-review&from=link"),
            "a dev build's scheme"
        );
    }

    #[test]
    fn places_open_at_their_location() {
        assert_eq!(parse("eos://runs/rn-82fa1c0d3e9b"), open("eos:/runs/rn-82fa1c0d3e9b"));
        assert_eq!(parse("eos://inbox/ib-1"), open("eos:/needs/ib-1"));
        assert_eq!(parse("eos://inbox"), open("eos:/needs"));
        assert_eq!(parse("eos://pair/abc"), Link::Pair);
    }

    #[test]
    fn an_issue_link_names_its_button_for_the_page_to_confirm() {
        assert_eq!(
            parse("eos://issue/si-000000000041?button=ask&index=2"),
            Link::Issue { id: "si-000000000041".into(), button: Some("ask".into()), index: Some(2) }
        );
        assert_eq!(parse("eos://issue/si-1"), Link::Issue { id: "si-1".into(), button: None, index: None });
        assert_eq!(
            issue_location("sf-3", Some(38), Some("ask"), Some(2)),
            "eos:/surfaces/sf-3?issue=38&button=ask&index=2"
        );
        assert_eq!(issue_location("sf-3", None, None, None), "eos:/surfaces/sf-3");
    }

    #[test]
    fn a_send_link_holds_text_or_one_web_address() {
        assert_eq!(parse("eos://send?text=hello+there%21"), Link::Send(Sent::Text("hello there!".into())));
        assert_eq!(
            parse("eos://send?url=https%3A%2F%2Fexample.com%2Fa"),
            Link::Send(Sent::Url("https://example.com/a".into()))
        );
        assert_eq!(parse("eos://send?url=file%3A%2F%2F%2Fetc%2Fpasswd"), Link::Window, "files never arrive by link");
        assert_eq!(parse("eos://send?text=a&url=https%3A%2F%2Fx"), Link::Window);
        assert_eq!(parse("eos://send"), Link::Window);
    }

    #[test]
    fn anything_outside_the_grammar_opens_the_window_and_nothing_more() {
        for link in [
            "eos://run/PR-Review",
            "eos://run/pr_review",
            &format!("eos://run/{}", "a".repeat(65)),
            "eos://run/pr-review?go=1",
            "eos://run/pr-review?show-only=yes",
            "eos://run/pr-review?opt.Depth=x",
            "eos://run/pr-review?note=%E0%A4%A",
            &format!("eos://run/pr-review?note={}", "a".repeat(MAX_VALUE + 1)),
            &format!("eos://send?text={}", "a".repeat(MAX_LINK)),
            "eos://runs/rn-1?x=1",
            "eos://runs/../x",
            "eos://issue/si-1?index=-1",
            "eos://issue/si-1?button=A",
            "eos://sign-in/abc",
            "eos://needs-you",
            "https://example.com",
            "eos:/runs/rn-1",
        ] {
            assert_eq!(parse(link), Link::Window, "{link}");
        }
    }
}
