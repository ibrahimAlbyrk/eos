//! Paths and queries, judged the way a URL parser resolves them.

use std::borrow::Cow;

/// Splits a request target into its path and its query (no `?`), dropping a fragment.
pub fn split_target(target: &str) -> (&str, &str) {
    let target = target.split('#').next().unwrap_or("");
    match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    }
}

fn is_single_dot(seg: &str) -> bool {
    seg == "." || seg.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(seg: &str) -> bool {
    matches!(seg.len(), 2 | 4 | 6)
        && (seg == ".."
            || seg.eq_ignore_ascii_case(".%2e")
            || seg.eq_ignore_ascii_case("%2e.")
            || seg.eq_ignore_ascii_case("%2e%2e"))
}

/// The path a URL parser would resolve `raw` to: `.` and `..` segments (also
/// percent-encoded) are applied, `\` counts as `/`, and the result starts with
/// `/`. Routes and access rules are judged on this form only — otherwise
/// `/ui/../policy/decide` would pass as `/ui/…`.
pub fn normalize_path(raw: &str) -> Cow<'_, str> {
    let clean = raw.starts_with('/')
        && !raw.contains('\\')
        && !raw.split('/').any(|seg| is_single_dot(seg) || is_double_dot(seg));
    if clean {
        return Cow::Borrowed(raw);
    }
    let mut segments: Vec<&str> = Vec::new();
    let mut trailing_slash = false;
    for seg in raw.split(['/', '\\']).skip(usize::from(raw.starts_with(['/', '\\']))) {
        trailing_slash = false;
        if is_double_dot(seg) {
            segments.pop();
            trailing_slash = true;
        } else if is_single_dot(seg) {
            trailing_slash = true;
        } else {
            segments.push(seg);
        }
    }
    let mut out = String::with_capacity(raw.len() + 1);
    for seg in &segments {
        out.push('/');
        out.push_str(seg);
    }
    if trailing_slash || out.is_empty() {
        out.push('/');
    }
    Cow::Owned(out)
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent`: `None` for a broken escape or bytes that are not UTF-8.
pub fn percent_decode(s: &str) -> Option<Cow<'_, str>> {
    if !s.contains('%') {
        return Some(Cow::Borrowed(s));
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex(*bytes.get(i + 1)?)?;
            let lo = hex(*bytes.get(i + 2)?)?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok().map(Cow::Owned)
}

/// Query-string decoding (`URLSearchParams`): `+` is a space, a broken escape
/// stays as written, bytes that are not UTF-8 become U+FFFD.
fn form_decode(s: &str) -> Cow<'_, str> {
    if !s.contains(['%', '+']) {
        return Cow::Borrowed(s);
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let pair = bytes.get(i + 1).copied().and_then(hex).zip(bytes.get(i + 2).copied().and_then(hex));
                if let Some((hi, lo)) = pair {
                    out.push(hi << 4 | lo);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b => out.push(b),
        }
        i += 1;
    }
    Cow::Owned(String::from_utf8_lossy(&out).into_owned())
}

/// A query string, decoded on lookup. Lookups scan the raw text: requests
/// carry a handful of parameters and most routes read one or two.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query(String);

impl Query {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// The text after `?`, as received.
    pub fn raw(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (Cow<'_, str>, Cow<'_, str>)> {
        self.0.split('&').filter(|pair| !pair.is_empty()).map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(name), form_decode(value))
        })
    }

    /// The first value of `name`.
    pub fn get(&self, name: &str) -> Option<Cow<'_, str>> {
        self.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    pub fn has(&self, name: &str) -> bool {
        self.iter().any(|(n, _)| n == name)
    }

    /// A comma-separated list: trimmed, empty items dropped.
    pub fn list(&self, name: &str) -> Vec<String> {
        self.get(name)
            .map(|v| v.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_target() {
        assert_eq!(split_target("/a/b?x=1&y=2#frag"), ("/a/b", "x=1&y=2"));
        assert_eq!(split_target("/a"), ("/a", ""));
        assert_eq!(split_target("/a?"), ("/a", ""));
    }

    #[test]
    fn resolves_dot_segments_like_a_url_parser() {
        // Expectations taken from `new URL(path, "http://localhost").pathname`.
        for (raw, want) in [
            ("/ui/../policy/decide", "/policy/decide"),
            ("/ui/./x", "/ui/x"),
            ("/a/b/..", "/a/"),
            ("/a/b/.", "/a/b/"),
            ("/../../x", "/x"),
            ("/a/%2e%2e/b", "/b"),
            ("/a/%2E./b", "/b"),
            ("/a/.%2e/b", "/b"),
            ("/a/%2e/b", "/a/b"),
            ("/ui\\..\\policy/decide", "/policy/decide"),
            ("/..", "/"),
            ("/", "/"),
            ("", "/"),
            ("/a//b", "/a//b"),
            ("/a/...", "/a/..."),
            ("/a/.b", "/a/.b"),
        ] {
            assert_eq!(normalize_path(raw), want, "{raw}");
        }
        assert!(matches!(normalize_path("/workers/w1/events"), Cow::Borrowed(_)));
    }

    #[test]
    fn decodes_components() {
        assert_eq!(percent_decode("/Users/a%20b/x.txt").as_deref(), Some("/Users/a b/x.txt"));
        assert_eq!(percent_decode("%E2%9C%93").as_deref(), Some("✓"));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%ff"), None);
        assert_eq!(percent_decode("%4"), None);
    }

    #[test]
    fn reads_queries() {
        let q = Query::new("since=abc-3&topics=worker:*,%20pages:change,,&focus=&a+b=c%20d&bad=%zz");
        assert_eq!(q.get("since").as_deref(), Some("abc-3"));
        assert_eq!(q.list("topics"), ["worker:*", "pages:change"]);
        assert!(q.has("focus"));
        assert_eq!(q.get("focus").as_deref(), Some(""));
        assert!(!q.has("ptys"));
        assert_eq!(q.get("a b").as_deref(), Some("c d"));
        assert_eq!(q.get("bad").as_deref(), Some("%zz"));
        assert_eq!(Query::default().iter().count(), 0);
    }
}
