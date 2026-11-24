//! The outbound check: what in a routine's result could reach someone or
//! somewhere that the item, the routine and the user did not name. A link
//! to a new host, an embedded image, a new `@mention`, a new mail address or
//! phone number, a secret, a result over the channel's limit. Slack's own
//! syntax counts too: `<@U…>` is a mention, `<!here>` and the other
//! broadcasts always flag, and `<url|label>` is a link. Any flag holds
//! an automatic delivery as a draft; a held draft shows its flags. Pure; a
//! result is the user's text, so nothing here logs.

use std::collections::{BTreeSet, HashSet};

use eos_contracts::ResultDoc;

use crate::redact::looks_secret;

/// A run of base64 this long, mixing capitals, small letters and digits,
/// may carry data out.
const BASE64_RUN: usize = 40;

/// What the check found. Declared in the order a check lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Flag {
    /// A link to a host the context does not name; one that only looks like
    /// one of its hosts is new too.
    NewHost,
    /// Any embedded image: loading it can carry data out.
    Image,
    NewMention,
    /// A mail address or phone number the context does not name.
    NewAddress,
    SecretLike,
    /// Over the channel's limit.
    TooLong,
}

impl Flag {
    pub fn as_str(self) -> &'static str {
        match self {
            Flag::NewHost => "new_host",
            Flag::Image => "image",
            Flag::NewMention => "new_mention",
            Flag::NewAddress => "new_address",
            Flag::SecretLike => "secret_like",
            Flag::TooLong => "too_long",
        }
    }
}

/// What a result may name without a flag: what the item's facts name, the
/// blueprint's allowlist and the user's own identities. Compared without
/// regard to case, a handle with or without its `@`, a number by its digits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundContext {
    /// Hosts (`github.com`), each only itself: no other host under it.
    pub hosts: Vec<String>,
    pub handles: Vec<String>,
    pub addresses: Vec<String>,
    pub numbers: Vec<String>,
    /// The channel's limit on a result's text, in bytes.
    pub max_bytes: usize,
}

impl OutboundContext {
    pub fn new(max_bytes: usize) -> Self {
        Self { hosts: Vec::new(), handles: Vec::new(), addresses: Vec::new(), numbers: Vec::new(), max_bytes }
    }

    /// Takes in every host, handle, address and number `text` names, as the
    /// check finds them.
    pub fn add_from(&mut self, text: &str) {
        self.hosts.extend(hosts(text));
        self.handles.extend(mentions(text));
        self.handles.extend(slack_ids(text));
        self.addresses.extend(addresses(text));
        self.numbers.extend(numbers(text));
    }
}

/// Every flag `doc` earns, each once, in [`Flag`]'s order.
pub fn check(doc: &ResultDoc, ctx: &OutboundContext) -> Vec<Flag> {
    let known =
        |list: &[String], normal: fn(&str) -> String| list.iter().map(|item| normal(item)).collect::<HashSet<_>>();
    let known_hosts = known(&ctx.hosts, |host| host.trim_end_matches('.').to_lowercase());
    let known_handles = known(&ctx.handles, |handle| handle.trim_start_matches('@').to_ascii_lowercase());
    let known_addresses = known(&ctx.addresses, str::to_lowercase);
    let known_numbers = known(&ctx.numbers, digits);
    let new = |found: Vec<String>, known: &HashSet<String>| found.iter().any(|item| !known.contains(item));
    // Markdown resolves a reference anywhere in its document, and a mail's
    // paragraphs are one document.
    let labels: HashSet<String> = doc.parts.iter().flat_map(|part| defined_labels(&part.text)).collect();

    let mut flags = BTreeSet::new();
    let mut flag = |on: bool, which: Flag| {
        if on {
            flags.insert(which);
        }
    };
    let mut bytes = 0;
    for part in &doc.parts {
        let text = part.text.as_str();
        bytes += text.len();
        flag(new(hosts(text), &known_hosts), Flag::NewHost);
        flag(has_image(text, &labels), Flag::Image);
        let unquoted = outside_code(text);
        flag(new(mentions(&unquoted), &known_handles) || broadcast(&unquoted), Flag::NewMention);
        flag(new(addresses(text), &known_addresses) || new(numbers(text), &known_numbers), Flag::NewAddress);
        flag(secret_like(text), Flag::SecretLike);
    }
    flag(bytes > ctx.max_bytes, Flag::TooLong);
    flags.into_iter().collect()
}

/// The host of every link: after a scheme's `://`, after a `//` that opens
/// a link's target (`](//`, `src="//`, a reference's `]: //`), and a `www.`
/// name on its own.
fn hosts(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (at, _) in text.match_indices("//") {
        let before = &text[..at];
        let scheme = before.strip_suffix(':').is_some_and(|b| b.ends_with(|c: char| c.is_ascii_alphanumeric()));
        // Markdown lets a target sit in `<…>` and after spaces.
        let opener = before.trim_end_matches('<').trim_end();
        if scheme || opener.ends_with(['(', '"', '\'', '=']) || opener.ends_with("]:") {
            found.extend(host_at(&text[at + 2..]));
        }
    }
    for (at, _) in text.match_indices("www.") {
        let joined = text[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || "./-@_".contains(c));
        if !joined {
            found.extend(host_at(&text[at..]));
        }
    }
    found
}

/// The host a link's authority names: user info and port cut, lowercase,
/// without a closing dot.
fn host_at(rest: &str) -> Option<String> {
    let ends = |c: char| c.is_whitespace() || "/\\?#\"'<>(){}`,;|".contains(c);
    let authority = &rest[..rest.find(ends).unwrap_or(rest.len())];
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6.find(']').map_or(host, |end| &host[..end + 2]),
        None => &host[..host.find(['[', ']', ':']).unwrap_or(host.len())],
    };
    let host = host.trim_end_matches('.').to_lowercase();
    (!host.is_empty()).then_some(host)
}

/// An embedded image: Markdown's `![…](…)`, `![…][…]`, or `![…]` alone
/// when `defined` holds its label; an HTML image; a `data:image/` address.
fn has_image(text: &str, defined: &HashSet<String>) -> bool {
    let lower = text.to_ascii_lowercase();
    let markdown = text.match_indices("![").any(|(at, _)| {
        let rest = paragraph(&text[at + 2..]);
        rest.contains("](")
            || rest.contains("][")
            || rest.split_once(']').is_some_and(|(label, _)| defined.contains(&label_key(label)))
    });
    markdown || ["<img", "<image", "<picture", "<svg", "data:image/"].iter().any(|tag| lower.contains(tag))
}

/// `text` up to the blank line that ends its paragraph: an image's text may
/// run over lines, but not past its paragraph.
fn paragraph(text: &str) -> &str {
    let mut end = 0;
    for line in text.split_inclusive('\n') {
        if end > 0 && line.trim().is_empty() {
            break;
        }
        end += line.len();
    }
    &text[..end]
}

/// The labels the `[…]: …` lines of `text` define, in a quote or a list item
/// too: Markdown counts a definition there for the whole document.
fn defined_labels(text: &str) -> impl Iterator<Item = String> + '_ {
    let container = |c: char| c.is_whitespace() || c.is_ascii_digit() || matches!(c, '>' | '-' | '*' | '+' | '.' | ')');
    text.lines().filter_map(move |line| {
        line.trim_start_matches(container).strip_prefix('[')?.split_once("]:").map(|(label, _)| label_key(label))
    })
}

/// A reference label as Markdown matches it: case and runs of spaces do not
/// count.
fn label_key(label: &str) -> String {
    label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// `text` without its code (fenced blocks and inline spans): a mention
/// there notifies nobody.
fn outside_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('`') {
        out.push_str(&rest[..open]);
        let ticks = rest[open..].len() - rest[open..].trim_start_matches('`').len();
        let fence = &rest[open..open + ticks];
        let after = &rest[open + ticks..];
        match after.find(fence) {
            Some(close) => {
                out.push(' ');
                rest = &after[close + ticks..];
            }
            // Ticks that never close are text.
            None => {
                out.push_str(fence);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Every `@handle`, lowercase and without its `@`: a user (`@octocat`) or a
/// team (`@acme/core`). An `@` inside a word (a mail address) is none.
fn mentions(text: &str) -> Vec<String> {
    let handle_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/');
    let mut found = Vec::new();
    for (at, _) in text.match_indices('@') {
        let joined = text[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || "-_./".contains(c));
        let rest = &text[at + 1..];
        let handle =
            rest[..rest.find(|c: char| !handle_char(c)).unwrap_or(rest.len())].trim_end_matches(['-', '_', '/']);
        if !joined && handle.starts_with(|c: char| c.is_ascii_alphanumeric()) {
            found.push(handle.to_ascii_lowercase());
        }
    }
    found
}

/// The Slack member ids a text names on their own (`U0123ABCD`, as an
/// item's facts or a Goes-to entry hold them), lowercase as a mention reads.
fn slack_ids(text: &str) -> Vec<String> {
    let id = |word: &str| {
        word.len() >= 9
            && word.starts_with(['U', 'W'])
            && word.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && word.chars().any(|c| c.is_ascii_digit())
    };
    text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| id(word)).map(str::to_ascii_lowercase).collect()
}

/// Slack's broadcasts, which notify a crowd: `<!here>`, `<!channel>`,
/// `<!everyone>` and a user group's `<!subteam^…>`.
fn broadcast(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("<!").any(|(at, _)| {
        let name = &lower[at + 2..];
        let name = &name[..name.find(['>', '|', '^']).unwrap_or(name.len())];
        matches!(name, "here" | "channel" | "everyone" | "subteam")
    })
}

/// Every mail address, lowercase.
fn addresses(text: &str) -> Vec<String> {
    let local_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-');
    let domain_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-');
    let mut found = Vec::new();
    for (at, _) in text.match_indices('@') {
        let start = text[..at].char_indices().rev().take_while(|(_, c)| local_char(*c)).last().map(|(i, _)| i);
        let rest = &text[at + 1..];
        let domain = rest[..rest.find(|c: char| !domain_char(c)).unwrap_or(rest.len())].trim_end_matches(['.', '-']);
        let has_tld = domain.rsplit_once('.').is_some_and(|(name, tld)| {
            !name.is_empty() && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())
        });
        if let (Some(start), true) = (start, has_tld) {
            found.push(format!("{}@{domain}", &text[start..at]).to_lowercase());
        }
    }
    found
}

/// Every phone number written to be dialled from anywhere (`+90 532 123 45
/// 67`, `tel:555-0100`), as its digits.
fn numbers(text: &str) -> Vec<String> {
    let number_char = |c: char| c.is_ascii_digit() || matches!(c, ' ' | '-' | '.' | '(' | ')');
    let mut found = Vec::new();
    let starts = text.match_indices('+').map(|(at, _)| at + 1).filter(|after| {
        let joined = text[..after - 1].chars().next_back().is_some_and(char::is_alphanumeric);
        !joined && text[*after..].starts_with(|c: char| c.is_ascii_digit())
    });
    let tel = text.match_indices("tel:").map(|(at, _)| at + 4 + usize::from(text[at + 4..].starts_with('+')));
    for after in starts.chain(tel) {
        let rest = &text[after..];
        let number = digits(&rest[..rest.find(|c: char| !number_char(c)).unwrap_or(rest.len())]);
        if (7..=15).contains(&number.len()) {
            found.push(number);
        }
    }
    found
}

fn digits(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// A secret in `redact`'s key or token shapes, or a long run of base64.
fn secret_like(text: &str) -> bool {
    let shaped = looks_secret(text);
    // A `/` ends a run: base64 has one only now and then, a path every few
    // letters.
    let base64 = text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '_'))).any(|run| {
        run.len() >= BASE64_RUN
            && run.chars().any(|c| c.is_ascii_uppercase())
            && run.chars().any(|c| c.is_ascii_lowercase())
            && run.chars().any(|c| c.is_ascii_digit())
    });
    shaped || base64
}

#[cfg(test)]
mod tests;
