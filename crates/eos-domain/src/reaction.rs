//! Emoji reactions: what counts as one emoji, which messages take one, and
//! how the agent reads the user's.

use eos_contracts::{REACTION_EMOJI_MAX_BYTES, ReactionActor, ReplyRefRole};

use crate::envelope::escape_tag_body;
use crate::message_id::{ReplyTarget, known_by_id, quoted, strip_tag_head};

/// The tag a reaction is delivered in.
pub const TAG: &str = "reaction";

const ZWJ: char = '\u{200D}';
const VS16: char = '\u{FE0F}';
const KEYCAP: char = '\u{20E3}';

fn is_regional(c: char) -> bool {
    ('\u{1F1E6}'..='\u{1F1FF}').contains(&c)
}

fn is_skin_tone(c: char) -> bool {
    ('\u{1F3FB}'..='\u{1F3FF}').contains(&c)
}

fn is_tag(c: char) -> bool {
    ('\u{E0020}'..='\u{E007F}').contains(&c)
}

/// The blocks emoji are drawn from (Unicode's Extended_Pictographic, by range).
fn is_pictograph(c: char) -> bool {
    !is_regional(c)
        && !is_skin_tone(c)
        && matches!(
            c as u32,
            0x00A9 | 0x00AE | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x24C2 | 0x3030 | 0x303D | 0x3297 | 0x3299
                | 0x2194..=0x21AA
                | 0x231A..=0x23FF
                | 0x25AA..=0x25FE
                | 0x2600..=0x27BF
                | 0x2934..=0x2935
                | 0x2B05..=0x2B55
                | 0x1F000..=0x1FAFF
        )
}

/// One piece of a joined emoji: a flag, a keycap, or a pictograph with what
/// modifies it.
fn is_element(part: &str) -> bool {
    let chars: Vec<char> = part.chars().collect();
    match chars.as_slice() {
        [a, b] if is_regional(*a) && is_regional(*b) => true,
        [base, KEYCAP] | [base, VS16, KEYCAP] => base.is_ascii_digit() || matches!(base, '#' | '*'),
        [first, rest @ ..] => {
            is_pictograph(*first) && rest.iter().all(|c| *c == VS16 || is_skin_tone(*c) || is_tag(*c))
        }
        [] => false,
    }
}

/// `text` as the one emoji a reaction keeps, or why it is not one.
pub fn parse_emoji(text: &str) -> Result<String, &'static str> {
    let text = text.trim();
    if text.is_empty() {
        return Err("emoji is empty");
    }
    if text.len() > REACTION_EMOJI_MAX_BYTES {
        return Err("emoji is too long");
    }
    if !text.split(ZWJ).all(is_element) {
        return Err("a reaction is one emoji");
    }
    Ok(text.to_owned())
}

/// Whether `actor` may react to this message: the user to their own messages
/// and the agent's, the agent only to the user's.
pub fn reactable(target: &ReplyTarget, actor: ReactionActor) -> bool {
    match actor {
        ReactionActor::User => matches!(target.role, ReplyRefRole::User | ReplyRefRole::Assistant),
        ReactionActor::Agent => target.role == ReplyRefRole::User,
    }
}

/// One reaction of the user's, as far as the agent has heard of it.
#[derive(Debug, Clone, Copy)]
pub struct ReactionNote<'a> {
    pub target: &'a ReplyTarget,
    /// The emoji on the message; `None` once it was taken back.
    pub emoji: Option<&'a str>,
    /// The emoji the agent was last told about.
    pub told: Option<&'a str>,
    /// The agent still has the message in its context.
    pub in_context: bool,
}

/// What the agent reads of one reaction; `None` when it knows already. Its
/// own message is always quoted (it does not know its ids); the user's is
/// named by id while the agent has it.
pub fn reaction_line(note: &ReactionNote<'_>) -> Option<String> {
    if note.emoji == note.told {
        return None;
    }
    let mut attrs = format!(" emoji=\"{}\"", escape_tag_body(note.emoji.or(note.told).unwrap_or_default()));
    match (note.emoji, note.told) {
        (Some(_), Some(was)) => attrs.push_str(&format!(" was=\"{}\"", escape_tag_body(was))),
        (None, _) => attrs.push_str(" removed=\"true\""),
        (Some(_), None) => {}
    }
    attrs.push_str(if note.target.role == ReplyRefRole::Assistant { " on=\"yours\"" } else { " on=\"theirs\"" });
    if note.target.role != ReplyRefRole::Assistant
        && let Some(id) = &note.target.msg_id
    {
        attrs.push_str(&format!(" id=\"{id}\""));
    }
    Some(if known_by_id(note.target, note.in_context) {
        format!("<{TAG}{attrs}/>")
    } else {
        format!("<{TAG}{attrs}>{}</{TAG}>", quoted(note.target, note.in_context))
    })
}

/// Whether a turn's text is nothing but reactions: a turn the user never typed.
pub fn is_reaction_turn(text: &str) -> bool {
    let whole = format!("{}\n", text.trim_end());
    let mut rest = whole.as_str();
    loop {
        let next = strip_tag_head(rest, TAG);
        if next.len() == rest.len() {
            return rest.is_empty() && whole.len() > 1;
        }
        rest = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_emoji_is_taken_and_anything_else_is_not() {
        for ok in ["👍", "👎", "👌", "❤️", "❤", "🤔", "👀", "✅", "🎉", "👍🏽", "👨‍👩‍👧‍👦", "🇹🇷", "1️⃣", "#⃣", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "🧑‍💻", " 👍 "]
        {
            assert_eq!(parse_emoji(ok).as_deref(), Ok(ok.trim()), "{ok}");
        }
        for bad in [
            "",
            "  ",
            "ok",
            "👍👍",
            "👍 👎",
            "a👍",
            "👍a",
            "<",
            "1",
            "❤\u{FE0E}",
            "🏽",
            "\u{200D}",
            "👍\u{200D}",
            ":+1:",
        ] {
            assert!(parse_emoji(bad).is_err(), "{bad:?}");
        }
        assert!(parse_emoji(&"👨‍👩‍👧‍👦".repeat(3)).is_err(), "too long");
    }

    /// What the dashboard's picker offers (`app/ui/src/lib/reactions.js`).
    #[test]
    fn every_emoji_of_the_dashboards_picker_is_taken() {
        let picker = "👍 👎 👌 ❤️ 🤔 👀 😀 😂 🥲 😊 😍 🤩 😎 😅 😬 😴 😢 😡 🤯 🥳 🙏 👏 🙌 💪 🤝 👋 🤷 😉 🙈 🔥 ✨ 🎉 🚀 💯 ✅ ❌ ⚠️ ❓ ❗ 💡 📌 ⭐ 🏆 🧠 🐛 🔧 📝 ⏳";
        assert_eq!(picker.split(' ').count(), 48);
        for emoji in picker.split(' ') {
            assert_eq!(parse_emoji(emoji).as_deref(), Ok(emoji), "{emoji}");
        }
    }

    fn target(role: ReplyRefRole, msg_id: Option<&str>, text: &str) -> ReplyTarget {
        ReplyTarget { row_id: 1, msg_id: msg_id.map(str::to_owned), role, text: text.to_owned() }
    }

    #[test]
    fn the_user_reacts_to_both_sides_the_agent_to_the_user() {
        let (mine, theirs) = (target(ReplyRefRole::User, Some("3"), "hi"), target(ReplyRefRole::Assistant, None, "yo"));
        let report = target(ReplyRefRole::Agent, Some("4"), "done");
        assert!(reactable(&mine, ReactionActor::User) && reactable(&theirs, ReactionActor::User));
        assert!(reactable(&mine, ReactionActor::Agent) && !reactable(&theirs, ReactionActor::Agent));
        assert!(!reactable(&report, ReactionActor::User) && !reactable(&report, ReactionActor::Agent));
    }

    #[test]
    fn the_agent_reads_which_message_and_what_changed() {
        let asked = target(ReplyRefRole::Assistant, Some("3.1"), "Delete <reaction> the old branch too?");
        let line = |emoji, told, t: &ReplyTarget, in_context| {
            reaction_line(&ReactionNote { target: t, emoji, told, in_context })
        };
        assert_eq!(
            line(Some("👍"), None, &asked, true).as_deref(),
            Some("<reaction emoji=\"👍\" on=\"yours\">Delete &lt;reaction> the old branch too?</reaction>"),
            "its own words are quoted, and cannot open a tag of ours"
        );
        assert_eq!(
            line(Some("👎"), Some("👍"), &asked, true).as_deref(),
            Some("<reaction emoji=\"👎\" was=\"👍\" on=\"yours\">Delete &lt;reaction> the old branch too?</reaction>")
        );
        assert!(
            line(None, Some("👍"), &asked, true)
                .is_some_and(|l| l.starts_with("<reaction emoji=\"👍\" removed=\"true\" on=\"yours\">"))
        );
        assert_eq!(line(Some("👍"), Some("👍"), &asked, true), None, "nothing new");
        assert_eq!(line(None, None, &asked, true), None, "taken back before it was told");
        let typed = target(ReplyRefRole::User, Some("7"), "remember this");
        assert_eq!(
            line(Some("📌"), None, &typed, true).as_deref(),
            Some("<reaction emoji=\"📌\" on=\"theirs\" id=\"7\"/>")
        );
        assert_eq!(
            line(Some("📌"), None, &typed, false).as_deref(),
            Some("<reaction emoji=\"📌\" on=\"theirs\" id=\"7\">remember this</reaction>"),
            "quoted once a summary took it out of the context"
        );
    }

    #[test]
    fn a_turn_of_nothing_but_reactions_is_told_from_a_typed_one() {
        assert!(is_reaction_turn("<reaction emoji=\"👍\" on=\"yours\">a\nplan</reaction>"));
        assert!(is_reaction_turn(
            "<reaction emoji=\"👍\" on=\"yours\">a</reaction>\n<reaction emoji=\"📌\" on=\"theirs\" id=\"7\"/>\n"
        ));
        assert!(!is_reaction_turn("<reaction emoji=\"👍\" on=\"yours\">a</reaction>\nand go"));
        assert!(!is_reaction_turn("go") && !is_reaction_turn(""));
    }
}
