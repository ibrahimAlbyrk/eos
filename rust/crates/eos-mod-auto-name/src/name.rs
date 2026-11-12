//! The rules of an automatic chat name (`manager/modules/auto-name/autoName.ts`):
//! which requests are worth naming, and what of a model's answer is a name.
//! Everything fails closed: when in doubt the chat keeps its default name.

/// What the model answers when a request cannot be named.
pub const NO_TITLE_SENTINEL: &str = "NO_TITLE";

// A request below any of these is not named: no model call is spent on it.
const MIN_CHARS: usize = 6;
const MIN_WORDS: usize = 2;
const MIN_DISTINCT_LETTERS: usize = 3;
/// A first line with more words than this is an answer, not a topic.
const MAX_TOPIC_WORDS: usize = 6;
/// A line this long may be the request parroted back; a shorter one is the
/// asked-for 2–4 word topic and may well open with the request's own words.
const ECHO_CHECK_MIN_WORDS: usize = 5;
/// A role word the model may tack on out of habit; a trailing one is dropped.
const ROLE_WORD: &str = "orchestrator";
const MAX_TOPIC_CHARS: usize = 48;
/// An echo shares more than this many leading letters and digits with the request.
const ECHO_PREFIX: usize = 12;

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '\'' || c == '-'
}

/// Words as `\p{L}[\p{L}\p{N}'-]*` counts them.
fn word_count(text: &str) -> usize {
    let mut words = 0;
    let mut inside = false;
    for c in text.chars() {
        if inside {
            inside = is_word_char(c);
        }
        if !inside && c.is_alphabetic() {
            inside = true;
            words += 1;
        }
    }
    words
}

/// Whether a request says enough to be named at all: greetings, single
/// words, gibberish and symbols are not. Letters of any script count.
pub fn is_nameable(user_input: &str) -> bool {
    let trimmed = eos_domain::text::js_trim(user_input);
    if trimmed.encode_utf16().count() < MIN_CHARS || word_count(trimmed) < MIN_WORDS {
        return false;
    }
    let mut letters: Vec<char> = trimmed.to_lowercase().chars().filter(|c| c.is_alphabetic()).collect();
    letters.sort_unstable();
    letters.dedup();
    letters.len() >= MIN_DISTINCT_LETTERS
}

/// The openings of a model that answered instead of naming
/// (`\b(sorry|i can'?t|i am unable|as an ai|here'?s|sure,)\b`, any case).
fn is_refusal(line: &str) -> bool {
    let lower = line.to_lowercase();
    let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
    ["sorry", "i cant", "i can't", "i am unable", "as an ai", "heres", "here's", "sure,"].iter().any(|opening| {
        lower.match_indices(opening).any(|(at, found)| {
            let before = lower[..at].chars().next_back();
            let after = lower[at + found.len()..].chars().next();
            // `sure,` ends in a non-word character: the boundary after it needs a word character.
            let closes = if opening.ends_with(',') { !boundary(after) } else { boundary(after) };
            boundary(before) && closes
        })
    })
}

/// The first line that says something, without control characters, wrapping
/// quotes, backticks or emphasis, and trailing punctuation.
fn first_scrubbed_line(raw: &str) -> String {
    let line = raw.replace('\r', "");
    let line = line.split('\n').map(eos_domain::text::js_trim).find(|l| !l.is_empty()).unwrap_or_default();
    let line: String = line.chars().map(|c| if c.is_control() && (c as u32) < 0x80 { ' ' } else { c }).collect();
    let wrapping = |c: char| matches!(c, '"' | '\'' | '`' | '*' | '_') || c.is_whitespace();
    let line = line.trim_start_matches(|c| wrapping(c) || c == '#' || c == '>').trim_end_matches(wrapping);
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    line.trim_end_matches(['.', ',', ';', ':', '!', '?']).trim().to_owned()
}

fn alnum(text: &str) -> Vec<char> {
    text.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

/// The model reproduced the request from its start. (Being contained in the
/// request is no sign: a real topic often appears in it word for word.)
fn is_echo(line: &str, user_input: &str) -> bool {
    let (a, b) = (alnum(line), alnum(user_input));
    !a.is_empty() && !b.is_empty() && a.iter().zip(&b).take_while(|(x, y)| x == y).count() > ECHO_PREFIX
}

/// The first letter of each word and hyphenated part in upper case; the rest
/// stays, so an acronym survives.
fn title_case(word: &str) -> String {
    let part = |part: &str| {
        let mut chars = part.chars();
        chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
    };
    word.split('-').map(part).collect::<Vec<_>>().join("-")
}

/// Whole words up to `MAX_TOPIC_CHARS`; a single longer word is cut.
fn clamp(words: Vec<String>) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut len = 0;
    for word in &words {
        let add = usize::from(!out.is_empty()) + word.encode_utf16().count();
        if len + add > MAX_TOPIC_CHARS {
            break;
        }
        out.push(word);
        len += add;
    }
    match (out.is_empty(), words.first()) {
        (true, Some(first)) => first.chars().take(MAX_TOPIC_CHARS).collect(),
        _ => out.join(" "),
    }
}

/// A model's answer as a chat name, or `None` when it is not a topic: empty,
/// the sentinel, a refusal, the request echoed back, or too long to be one.
pub fn interpret_model_output(raw: &str, user_input: &str) -> Option<String> {
    let line = first_scrubbed_line(raw);
    if line.is_empty() || line == NO_TITLE_SENTINEL || is_refusal(&line) {
        return None;
    }
    let words = line.split_whitespace().count();
    if (words >= ECHO_CHECK_MIN_WORDS && is_echo(&line, user_input)) || words > MAX_TOPIC_WORDS {
        return None;
    }
    let mut words: Vec<String> = line.split(' ').filter(|w| !w.is_empty()).map(title_case).collect();
    if words.last().is_some_and(|last| last.to_lowercase() == ROLE_WORD) {
        words.pop();
    }
    Some(clamp(words)).filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    // manager/modules/auto-name/__tests__/autoName.test.ts
    #[test]
    fn greetings_single_words_and_symbols_are_not_named() {
        for bad in ["hi", "asdf", "??", "Kafka", "aaaa aaaa", "12345 67890"] {
            assert!(!is_nameable(bad), "{bad}");
        }
        assert!(is_nameable("fix the login bug"));
        assert!(is_nameable("iOS relay bağlantısını düzelt"), "letters of any script count");
    }

    #[test]
    fn a_models_answer_is_a_name_only_when_it_is_a_topic() {
        assert_eq!(interpret_model_output(NO_TITLE_SENTINEL, ""), None);
        assert_eq!(interpret_model_output("NO_TITLE", "fix the login bug"), None);
        assert_eq!(interpret_model_output("I'm sorry, I can't do that", ""), None);
        assert_eq!(interpret_model_output("Sure, here's a title", ""), None);
        assert_eq!(
            interpret_model_output("fix the login bug in auth", "fix the login bug in the auth module please"),
            None,
            "five words that open as the request does"
        );
        assert_eq!(
            interpret_model_output("Pending Permission Tool", "pending permission tool'u düzelt lütfen").as_deref(),
            Some("Pending Permission Tool"),
            "a short topic may open with the request's own words"
        );
        assert_eq!(interpret_model_output("This line has far too many words to be a topic", ""), None);
        assert_eq!(
            interpret_model_output("Kafka Consumer", "rewrite the Kafka consumer").as_deref(),
            Some("Kafka Consumer")
        );
    }

    #[test]
    fn a_name_is_title_cased_scrubbed_and_clamped() {
        assert_eq!(interpret_model_output("game fix", "").as_deref(), Some("Game Fix"));
        assert_eq!(interpret_model_output("Auth Refactor Orchestrator", "").as_deref(), Some("Auth Refactor"));
        assert_eq!(interpret_model_output("game fix orchestrator", "").as_deref(), Some("Game Fix"));
        assert_eq!(interpret_model_output("**\"game fix.\"**\nmore", "").as_deref(), Some("Game Fix"));
        assert_eq!(interpret_model_output("REST API cleanup", "").as_deref(), Some("REST API Cleanup"));
        assert_eq!(interpret_model_output("well-known type-ahead", "").as_deref(), Some("Well-Known Type-Ahead"));
        for bad in ["", "   ", "...", "\n\n", "Orchestrator", "\"\""] {
            assert_eq!(interpret_model_output(bad, ""), None, "{bad:?}");
        }
        let long = interpret_model_output(&format!("{} tail", "x".repeat(60)), "").expect("a name");
        assert_eq!(long.chars().count(), 48, "one runaway word is cut");
        let wordy = interpret_model_output("aaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbb cccccccccccccccccccc", "");
        assert_eq!(wordy.as_deref(), Some("Aaaaaaaaaaaaaaaaaaaa Bbbbbbbbbbbbbbbbbbbb"), "whole words only");
    }
}
