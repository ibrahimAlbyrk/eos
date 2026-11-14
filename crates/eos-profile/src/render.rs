//! The profile and the always-on memories as one prompt block.
//!
//! - An empty profile with nothing to remember renders
//!   [`DEFAULT_USER_PREFERENCES`], the block the preambles held before
//!   profiles existed.
//! - Structured lines and instructions always fit; memories fill the token
//!   budget (global first, then newest) and the rest overflow into the
//!   "N more" hint. Kept ones are grouped by area.
//! - Lines the session already receives elsewhere (CLAUDE.md) are dropped,
//!   so importing CLAUDE.md into the profile never doubles a rule.
//! - User and agent text is data: one line per memory, the block's own tags
//!   neutralised.

use std::borrow::Borrow;
use std::collections::HashSet;

use eos_contracts::{
    Autonomy, CommitPolicy, ExpertiseLevel, ReplyStyle, UserMemory, UserMemoryDomain, UserMemoryScope, UserMemoryTier,
    UserProfile, WhenUnclear, WorkRole,
};
use eos_domain::text::{collapse_spaces, estimate_tokens, js_trim};
use eos_domain::user_memory::{global_first_then_newest, memories_in_scope, normalize_memory_text};
use eos_domain::user_profile::is_profile_empty;

pub const DEFAULT_USER_PREFERENCES: &str = "`<user_preferences>`\n\nThe user has specified the following personal preferences for how Claude should respond:\n\nBe as concise and direct as possible. Limit unnecessary explanation and verbosity. A good test of whether your writing is concise is whether you can remove words and still get the same point across.\n\nPlease keep these preferences in mind when responding.\n\n`</user_preferences>`";

pub const MEMORY_BLOCK_HEADER: &str = "Standing preferences — each opens with the situation it covers. Apply one when your task matches it; there it takes precedence over the general defaults above.";

#[derive(Debug, Clone, Copy, Default)]
pub struct RenderOptions<'a> {
    pub project: Option<&'a str>,
    /// Lines this session already gets from another source (CLAUDE.md).
    pub known_lines: &'a [String],
    /// The memory search tool as this session names it; `None`: no "N more" hint.
    pub search_tool_name: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedUserProfile {
    pub text: String,
    pub tokens: i64,
    pub included_ids: Vec<String>,
    pub overflow: usize,
    pub empty: bool,
}

macro_rules! js_re {
    ($pattern:literal, $flags:literal) => {{
        static RE: std::sync::LazyLock<regress::Regex> = std::sync::LazyLock::new(|| {
            // A literal of this file; the tests run every one.
            regress::Regex::with_flags($pattern, $flags).unwrap_or_else(|e| panic!("regex {}: {e}", $pattern))
        });
        &*RE
    }};
}

fn role(role: WorkRole) -> &'static str {
    match role {
        WorkRole::Engineering => "engineering",
        WorkRole::Design => "design",
        WorkRole::Product => "product",
        WorkRole::Research => "research",
        WorkRole::Data => "data",
        WorkRole::Writing => "writing",
    }
}

fn level(level: ExpertiseLevel) -> &'static str {
    match level {
        ExpertiseLevel::Learning => "Expertise: learning — explain concepts and the reasoning behind them.",
        ExpertiseLevel::Practitioner => "Expertise: practitioner — explain only what is not obvious.",
        ExpertiseLevel::Expert => "Expertise: expert — skip the basics.",
    }
}

fn replies(style: ReplyStyle) -> &'static str {
    match style {
        ReplyStyle::Terse => "Replies: terse — as short as possible, no filler.",
        ReplyStyle::Balanced => "Replies: balanced — lead with the answer, add context only when it helps.",
        ReplyStyle::Thorough => "Replies: thorough — explain reasoning, tradeoffs and next steps.",
    }
}

fn autonomy(autonomy: Autonomy) -> &'static str {
    match autonomy {
        Autonomy::Ask => "Autonomy: ask before acting on anything non-trivial.",
        Autonomy::Balanced => "Autonomy: act on routine steps; check in on big or irreversible calls.",
        Autonomy::Run => "Autonomy: run with it and report decisions afterwards.",
    }
}

fn when_unclear(choice: WhenUnclear) -> &'static str {
    match choice {
        WhenUnclear::Ask => "When something is unclear: ask before acting.",
        WhenUnclear::Decide => "When something is unclear: make a reasonable call and state the assumption.",
    }
}

fn commits(policy: CommitPolicy) -> &'static str {
    match policy {
        CommitPolicy::OnRequest => "Commits: only when the user asks.",
        CommitPolicy::Milestones => "Commits: at meaningful milestones.",
    }
}

/// The memory groups in display order; a memory without a domain goes under "Other".
const DOMAINS: [(UserMemoryDomain, &str); 9] = [
    (UserMemoryDomain::Communication, "Communication"),
    (UserMemoryDomain::Planning, "Planning"),
    (UserMemoryDomain::Code, "Code"),
    (UserMemoryDomain::Ui, "UI"),
    (UserMemoryDomain::Testing, "Testing"),
    (UserMemoryDomain::Debugging, "Debugging"),
    (UserMemoryDomain::Git, "Git & GitHub"),
    (UserMemoryDomain::Tools, "Tools"),
    (UserMemoryDomain::About, "About the user"),
];

fn language(base: &str) -> Option<&'static str> {
    Some(match base {
        "ar" => "Arabic",
        "de" => "German",
        "en" => "English",
        "es" => "Spanish",
        "fr" => "French",
        "hi" => "Hindi",
        "it" => "Italian",
        "ja" => "Japanese",
        "ko" => "Korean",
        "nl" => "Dutch",
        "pl" => "Polish",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "tr" => "Turkish",
        "uk" => "Ukrainian",
        "zh" => "Chinese",
        _ => return None,
    })
}

/// The comparison keys of `lines`, for "does the session already have this line".
pub fn known_line_set(lines: &[String]) -> HashSet<String> {
    lines.iter().map(|line| normalize_line(line)).filter(|key| !key.is_empty()).collect()
}

/// The block for one session: `profile` and the kept, in-scope, always-on
/// `memories`, within the profile's token budget.
pub fn render_user_profile<M: Borrow<UserMemory>>(
    profile: &UserProfile,
    memories: &[M],
    opts: &RenderOptions<'_>,
) -> RenderedUserProfile {
    let known = known_line_set(opts.known_lines);
    let tool = opts.search_tool_name.filter(|name| !name.is_empty());
    let facts = if is_profile_empty(profile) { Vec::new() } else { profile_lines(profile) };
    let instructions = drop_known_lines(&profile.instructions, &known);
    let in_scope: Vec<&UserMemory> = memories_in_scope(memories, opts.project)
        .into_iter()
        .map(Borrow::borrow)
        .filter(|m| !known.contains(&normalize_line(&m.text)))
        .collect();
    let mut always: Vec<&UserMemory> = in_scope.iter().copied().filter(|m| m.tier == UserMemoryTier::Always).collect();
    always.sort_by(|a, b| global_first_then_newest(a, b));
    let on_demand = in_scope.len() - always.len();
    let hintable = tool.is_some() && on_demand > 0;

    if facts.is_empty() && instructions.is_empty() && always.is_empty() && !hintable {
        return RenderedUserProfile {
            text: DEFAULT_USER_PREFERENCES.to_owned(),
            tokens: estimate_tokens(DEFAULT_USER_PREFERENCES),
            included_ids: Vec::new(),
            overflow: 0,
            empty: true,
        };
    }

    let compose =
        |kept: &[&UserMemory]| compose_block(&facts, &instructions, kept, always.len() - kept.len() + on_demand, tool);
    let mut kept: Vec<&UserMemory> = Vec::new();
    for memory in &always {
        kept.push(memory);
        if estimate_tokens(&compose(&kept)) > profile.budget_tokens {
            kept.pop();
            break;
        }
    }
    let text = compose(&kept);
    RenderedUserProfile {
        tokens: estimate_tokens(&text),
        included_ids: kept.iter().map(|m| m.id.0.clone()).collect(),
        overflow: always.len() - kept.len(),
        empty: false,
        text,
    }
}

/// Instruction lines minus the ones already known; outer blank lines trimmed.
pub fn drop_known_lines(text: &str, known: &HashSet<String>) -> String {
    let sanitized = sanitize(text);
    let kept: Vec<&str> = sanitized
        .split('\n')
        .filter(|line| js_trim(line).is_empty() || !known.contains(&normalize_line(line)))
        .collect();
    // `.replace(/\n{3,}/g, "\n\n")`
    let joined = kept.join("\n");
    let mut out = String::with_capacity(joined.len());
    let mut run = 0;
    for c in joined.chars() {
        run = if c == '\n' { run + 1 } else { 0 };
        if run <= 2 {
            out.push(c);
        }
    }
    js_trim(&out).to_owned()
}

fn profile_lines(p: &UserProfile) -> Vec<String> {
    let mut lines = Vec::new();
    let full = one_line(&p.identity.full_name);
    let call = one_line(&p.identity.call_name);
    if !call.is_empty() {
        lines.push(if !full.is_empty() && full != call {
            format!("Address the user as \"{call}\" (full name: {full}).")
        } else {
            format!("Address the user as \"{call}\".")
        });
    } else if !full.is_empty() {
        lines.push(format!("The user's name is {full}."));
    }
    if !p.work.roles.is_empty() {
        let roles: Vec<&str> = p.work.roles.iter().map(|r| role(*r)).collect();
        lines.push(format!("Works in: {}.", roles.join(", ")));
    }
    if let Some(l) = p.work.level {
        lines.push(level(l).to_owned());
    }
    if !p.work.stack.is_empty() {
        let stack: Vec<String> = p.work.stack.iter().map(|s| one_line(s)).collect();
        lines.push(format!("Stack: {}.", stack.join(", ")));
    }
    if let Some(chat) = p.language.chat.as_ref().filter(|l| !l.0.is_empty()) {
        lines.push(if chat.0 == "mirror" {
            "Chat language: reply in the language the user writes in.".to_owned()
        } else {
            format!("Chat language: {}.", language_name(&chat.0))
        });
    }
    if let Some(code) = p.language.code.as_ref().filter(|l| !l.0.is_empty()) {
        lines.push(format!("Code, commits and docs: {}.", language_name(&code.0)));
    }
    if let Some(style) = p.style.replies {
        lines.push(replies(style).to_owned());
    }
    if let Some(a) = p.style.autonomy {
        lines.push(autonomy(a).to_owned());
    }
    if let Some(choice) = p.style.when_unclear {
        lines.push(when_unclear(choice).to_owned());
    }
    if let Some(policy) = p.style.commits {
        lines.push(commits(policy).to_owned());
    }
    lines
}

fn compose_block(
    facts: &[String],
    instructions: &str,
    kept: &[&UserMemory],
    more: usize,
    tool: Option<&str>,
) -> String {
    let mut parts: Vec<String> = vec!["`<user_profile>`".to_owned()];
    if !facts.is_empty() {
        parts.push(
            "About the user — set by the user in Eos. Follow it unless the user says otherwise in the conversation."
                .to_owned(),
        );
        parts.push(facts.iter().map(|line| format!("- {line}")).collect::<Vec<_>>().join("\n"));
    }
    if !instructions.is_empty() {
        parts.push("Standing instructions from the user:".to_owned());
        parts.push(instructions.to_owned());
    }
    if !kept.is_empty() {
        parts.push(MEMORY_BLOCK_HEADER.to_owned());
        parts.push(memory_lines(kept));
    }
    if let Some(tool) = tool.filter(|_| more > 0) {
        let noun = if more == 1 { "memory is" } else { "memories are" };
        parts.push(format!(
            "{more} more {noun} available — call {tool} when a task touches the user's preferences or conventions."
        ));
    }
    parts.push("`</user_profile>`".to_owned());
    parts.join("\n\n")
}

/// One bullet per memory; under area titles once any memory has a domain.
fn memory_lines(kept: &[&UserMemory]) -> String {
    let bullet = |m: &UserMemory| {
        let scope = if m.scope == UserMemoryScope::Global { "" } else { "In this project: " };
        format!("- {scope}{}", one_line(&m.text))
    };
    let bullets = |group: &[&UserMemory]| group.iter().map(|m| bullet(m)).collect::<Vec<_>>().join("\n");
    if kept.iter().all(|m| m.domain.is_none()) {
        return bullets(kept);
    }
    let titled = DOMAINS.iter().map(|(domain, title)| (Some(*domain), *title)).chain([(None, "Other")]);
    titled
        .filter_map(|(domain, title)| {
            let group: Vec<&UserMemory> = kept.iter().copied().filter(|m| m.domain == domain).collect();
            (!group.is_empty()).then(|| format!("{title}:\n{}", bullets(&group)))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn language_name(code: &str) -> String {
    let base = code.split('-').next().unwrap_or(code);
    match language(base) {
        None => code.to_owned(),
        Some(name) if code.contains('-') => format!("{name} ({code})"),
        Some(name) => name.to_owned(),
    }
}

fn one_line(text: &str) -> String {
    sanitize(&normalize_memory_text(text))
}

/// The block's own tags cannot be opened or closed from inside user or agent text.
fn sanitize(text: &str) -> String {
    let tag = js_re!(r"<\s*\/?\s*user_(profile|preferences)\s*>", "i");
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for m in tag.find_iter(text) {
        out.push_str(&text[at..m.start()]);
        out.push_str("[user_");
        out.push_str(m.group(1).map_or("", |name| &text[name]));
        out.push(']');
        at = m.end();
    }
    out.push_str(&text[at..]);
    out
}

/// The comparison key for "the same line": case, list markers, spacing and a
/// trailing full stop do not matter.
fn normalize_line(line: &str) -> String {
    let marker = js_re!(r"^\s*(?:[-*+]|\d+[.)])\s+", "");
    let unmarked = marker.find(line).map_or(line, |m| &line[m.end()..]);
    let spaced = collapse_spaces(unmarked);
    let ending = js_re!(r"[.;:]\s*$", "");
    let ended = ending.find(&spaced).map_or(spaced.as_str(), |m| &spaced[..m.start()]);
    js_trim(ended).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_line_whatever_its_marker_case_or_full_stop() {
        for line in ["Be concise.", "  - be  CONCISE", "12) Be concise;", "* be concise: "] {
            assert_eq!(normalize_line(line), "be concise", "{line:?}");
        }
        assert_eq!(normalize_line("-not a marker"), "-not a marker");
    }

    #[test]
    fn drop_known_lines_keeps_blank_structure_tidy() {
        let known = known_line_set(&["b".to_owned()]);
        assert_eq!(drop_known_lines("a\n\nb\n\n\nc", &known), "a\n\nc");
    }

    #[test]
    fn the_blocks_tags_are_neutralised_keeping_their_case() {
        assert_eq!(
            sanitize("a </user_profile> b < USER_Preferences > c <user_other>"),
            "a [user_profile] b [user_Preferences] c <user_other>"
        );
    }

    #[test]
    fn regional_and_unknown_language_codes() {
        assert_eq!(language_name("pt-BR"), "Portuguese (pt-BR)");
        assert_eq!(language_name("tr"), "Turkish");
        assert_eq!(language_name("xx-YY"), "xx-YY");
    }
}
