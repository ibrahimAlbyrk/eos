//! The few `<head>` hints the media resolver needs from a page: its preview
//! image and its icons (`infra/src/genui/html-meta.ts`). A tolerant scan over
//! `<meta>` and `<link>` tags, not an HTML parser: pages are capped at 1 MB
//! and only the head counts.

use std::sync::LazyLock;

use regress::Regex;
use url::Url;

fn regex(pattern: &str, flags: &str) -> Regex {
    // The patterns are constants of this file; a test compiles every one.
    Regex::with_flags(pattern, flags).unwrap_or_else(|e| panic!("pattern {pattern}: {e}"))
}

static TAG: LazyLock<Regex> = LazyLock::new(|| regex(r"<(meta|link)\b([^>]*)>", "i"));
static ATTR: LazyLock<Regex> =
    LazyLock::new(|| regex(r#"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?"#, ""));
static HEAD_END: LazyLock<Regex> = LazyLock::new(|| regex(r"</head\s*>|<body[\s>]", "i"));
static ENTITY: LazyLock<Regex> = LazyLock::new(|| regex(r"&(#?[a-zA-Z0-9]+);", ""));
static SIZE: LazyLock<Regex> = LazyLock::new(|| regex(r"(\d+)\s*x\s*(\d+)", "i"));
static SVG_FILE: LazyLock<Regex> = LazyLock::new(|| regex(r"\.svg(\?|$)", "i"));
static SCHEME: LazyLock<Regex> = LazyLock::new(|| regex(r"^[a-z][a-z0-9+.-]*://", "i"));
static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
    regex(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$", "")
});

fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" | "#39" | "#x27" => "'",
        "#x2F" | "#47" => "/",
        _ => return None,
    })
}

/// The handful of entities a URL in an attribute is written with; anything
/// else stays as it is.
fn decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for m in ENTITY.find_iter(s) {
        out.push_str(&s[last..m.start()]);
        let name = &s[m.group(1).unwrap_or(m.range())];
        let whole = &s[m.range()];
        out.push_str(entity(name).or_else(|| entity(&name.to_lowercase())).unwrap_or(whole));
        last = m.end();
    }
    out.push_str(&s[last..]);
    eos_domain::text::js_trim(&out).to_owned()
}

struct Tag {
    link: bool,
    /// Attribute names in lower case; a repeated attribute keeps its last value.
    attrs: Vec<(String, String)>,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

fn head_of(html: &str) -> &str {
    match HEAD_END.find(html) {
        Some(end) if end.start() > 0 => &html[..end.start()],
        _ => html,
    }
}

fn tags(html: &str) -> Vec<Tag> {
    let head = head_of(html);
    TAG.find_iter(head)
        .map(|m| {
            let name = m.group(1).map_or("", |r| &head[r]);
            let inside = m.group(2).map_or("", |r| &head[r]);
            let attrs = ATTR
                .find_iter(inside)
                .map(|a| {
                    let key = a.group(1).map_or("", |r| &inside[r]).to_lowercase();
                    let value = [2, 3, 4].into_iter().find_map(|g| a.group(g)).map_or("", |r| &inside[r]);
                    (key, decode(value))
                })
                .collect();
            Tag { link: name.eq_ignore_ascii_case("link"), attrs }
        })
        .collect()
}

/// `href` against `base`, when that is an http(s) URL.
fn absolute(href: &str, base: Option<&Url>) -> Option<String> {
    if href.is_empty() {
        return None;
    }
    let url = base?.join(href).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// The page's preview image: `og:image` (the secure URL first),
/// `twitter:image`, then `<link rel="image_src">`. Relative URLs resolve
/// against the page's URL.
pub(crate) fn extract_preview_image(html: &str, page_url: &str) -> Option<String> {
    let all = tags(html);
    let base = Url::parse(page_url).ok();
    let meta = |key: &str| {
        all.iter().filter(|t| !t.link).find_map(|t| {
            let named = t.attr("property").or_else(|| t.attr("name")).or_else(|| t.attr("itemprop")).unwrap_or("");
            let content = t.attr("content").filter(|content| !content.is_empty())?;
            (named.to_lowercase() == key).then_some(content)
        })
    };
    let linked = || {
        all.iter()
            .find(|t| t.link && t.attr("rel").unwrap_or("").to_lowercase() == "image_src")
            .and_then(|t| t.attr("href"))
    };
    ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image"]
        .into_iter()
        .map(meta)
        .chain(std::iter::once_with(linked))
        .flatten()
        .find_map(|candidate| absolute(candidate, base.as_ref()))
}

fn largest_side(sizes: Option<&str>) -> u64 {
    let Some(sizes) = sizes.filter(|sizes| !sizes.is_empty()) else { return 0 };
    if sizes.eq_ignore_ascii_case("any") {
        return 512;
    }
    SIZE.find_iter(sizes).filter_map(|m| m.group(1).and_then(|r| sizes[r].parse::<u64>().ok())).max().unwrap_or(0)
}

/// The page's icons, best first: apple-touch-icon (largest), then `rel=icon`
/// (vector, or largest), then `/apple-touch-icon.png` and `/favicon.ico` at
/// the site's root. Empty when `page_url` is not a URL.
pub(crate) fn extract_icons(html: &str, page_url: &str) -> Vec<String> {
    let Ok(base) = Url::parse(page_url) else { return Vec::new() };
    let mut apple: Vec<(String, u64)> = Vec::new();
    let mut icons: Vec<(String, u64)> = Vec::new();
    for tag in tags(html).iter().filter(|t| t.link) {
        let rel = tag.attr("rel").unwrap_or("").to_lowercase();
        let rel: Vec<&str> = rel.split(eos_domain::text::is_js_space).collect();
        let Some(url) = absolute(tag.attr("href").unwrap_or(""), Some(&base)) else { continue };
        let side = largest_side(tag.attr("sizes"));
        if rel.contains(&"apple-touch-icon") || rel.contains(&"apple-touch-icon-precomposed") {
            apple.push((url, if side == 0 { 180 } else { side }));
        } else if rel.contains(&"icon") {
            let vector = tag.attr("type").unwrap_or("").contains("svg") || SVG_FILE.find(&url).is_some();
            icons.push((
                url,
                if vector {
                    256
                } else if side == 0 {
                    32
                } else {
                    side
                },
            ));
        }
    }
    // Stable: equal scores keep the page's order.
    apple.sort_by_key(|icon| std::cmp::Reverse(icon.1));
    icons.sort_by_key(|icon| std::cmp::Reverse(icon.1));
    let mut ordered: Vec<String> = apple.into_iter().chain(icons).map(|(url, _)| url).collect();
    for fallback in ["apple-touch-icon.png", "favicon.ico"] {
        if let Ok(url) = base.join("/").and_then(|root| root.join(fallback)) {
            ordered.push(url.to_string());
        }
    }
    let mut seen = std::collections::HashSet::new();
    ordered.retain(|url| seen.insert(url.clone()));
    ordered
}

/// "Example.com", "https://www.example.com/a" → "example.com",
/// "www.example.com"; `None` when it is not a public-looking domain name.
pub(crate) fn normalize_site(site: &str) -> Option<String> {
    let raw = eos_domain::text::js_trim(site);
    if raw.is_empty() || raw.encode_utf16().count() > 253 {
        return None;
    }
    let url = if SCHEME.find(raw).is_some() { Url::parse(raw) } else { Url::parse(&format!("https://{raw}")) };
    let host = url.ok()?.host_str()?.to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    DOMAIN.find(host).is_some().then(|| host.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [&TAG, &ATTR, &HEAD_END, &ENTITY, &SIZE, &SVG_FILE, &SCHEME, &DOMAIN] {
            assert!(re.find("\u{0}").is_none());
        }
    }
}
