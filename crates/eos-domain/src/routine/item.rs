//! What makes two items the same item: the key a run of it is stored under,
//! so a routine that handled an item lately is asked before it does it again.

use eos_contracts::ItemRef;

/// The item's own `key`, else its link or its path written one way; `None`
/// for an item that names neither (a text, a day).
pub fn key(item: &ItemRef) -> Option<String> {
    let given =
        |text: &Option<String>| text.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    given(&item.key)
        .or_else(|| given(&item.url).map(|url| link(&url)))
        .or_else(|| given(&item.path).map(|path| folder_path(&path)))
}

/// An item handed in from outside Eos (a terminal, a chat agent): a link
/// when it is a web address, else its text. Never taken for the user's own
/// words, so it is marked untrusted.
pub fn outside(kind: &str, text: &str) -> ItemRef {
    let mut item = ItemRef {
        kind: kind.into(),
        key: None,
        title: None,
        url: None,
        path: None,
        text: None,
        date: None,
        range: None,
        version: None,
        untrusted: true,
    };
    match kind {
        "link" => item.url = Some(text.into()),
        "file" | "folder" => item.path = Some(text.into()),
        _ => item.text = Some(text.into()),
    }
    item
}

/// [`outside`] for typed text: a link when it is a web address.
pub fn typed(text: &str) -> ItemRef {
    let web = text.starts_with("https://") || text.starts_with("http://");
    outside(if web { "link" } else { "text" }, text)
}

/// A link without its fragment and trailing slash, its scheme and host in
/// lower case: the forms one page is pasted in.
fn link(url: &str) -> String {
    let url = url.split_once('#').map_or(url, |(before, _)| before);
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(host, path)| (host, path));
    let path = path.trim_end_matches('/');
    let mut out = String::with_capacity(url.len());
    if !scheme.is_empty() {
        out.push_str(&scheme.to_ascii_lowercase());
        out.push_str("://");
    }
    out.push_str(&host.to_ascii_lowercase());
    if !path.is_empty() {
        out.push('/');
        out.push_str(path);
    }
    out
}

/// A path without its trailing slash, the root kept.
fn folder_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() { "/".to_owned() } else { trimmed.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item() -> ItemRef {
        ItemRef {
            kind: "link".into(),
            key: None,
            title: None,
            url: None,
            path: None,
            text: None,
            date: None,
            range: None,
            version: None,
            untrusted: true,
        }
    }

    #[test]
    fn an_items_own_key_wins() {
        let given = ItemRef {
            key: Some(" github:pr:acme/game#482 ".into()),
            url: Some("https://github.com/acme/game/pull/482".into()),
            ..item()
        };
        assert_eq!(key(&given).as_deref(), Some("github:pr:acme/game#482"));
    }

    #[test]
    fn one_link_pasted_in_different_forms_is_one_item() {
        let of = |url: &str| key(&ItemRef { url: Some(url.into()), ..item() });
        let plain = of("https://github.com/acme/game/pull/482");
        assert_eq!(plain.as_deref(), Some("https://github.com/acme/game/pull/482"));
        assert_eq!(of("HTTPS://GitHub.com/acme/game/pull/482/"), plain);
        assert_eq!(of("https://github.com/acme/game/pull/482#discussion_r1"), plain);
        assert_ne!(of("https://github.com/acme/Game/pull/482"), plain, "a path keeps its case");
        assert_eq!(of("example.com/").as_deref(), Some("example.com"));
    }

    #[test]
    fn a_path_is_the_item_when_there_is_no_key_or_link() {
        let of = |path: &str| key(&ItemRef { path: Some(path.into()), ..item() });
        assert_eq!(of("/Users/me/Reports/").as_deref(), Some("/Users/me/Reports"));
        assert_eq!(of("/").as_deref(), Some("/"));
    }

    #[test]
    fn a_text_or_a_day_has_no_key() {
        assert_eq!(key(&ItemRef { text: Some("hello".into()), ..item() }), None);
        assert_eq!(key(&ItemRef { date: Some("2026-11-19".into()), key: Some("  ".into()), ..item() }), None);
    }
}
