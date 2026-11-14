//! The rules of dreaming: when a dream is due, which chats it reads, how a chat
//! is rendered for the recall pass (tagged with event ids, secrets scrubbed,
//! within a budget), which recall signals may become memories at all, and how
//! the model's answers become proposals the memory service can accept. What
//! does not validate is counted and dropped, never half-applied.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use eos_contracts::{
    DreamCandidate, DreamDropped, DreamProposalDraft, DreamProposalKind, DreamRejected, DreamSignal, DreamSignalObject,
    DreamSignalStance, DreamVerdict, DreamVerdictQuotesItemSays, UserMemory, UserMemoryScope, UserMemoryStatus,
};
use eos_domain::text::{js_trim, js_trim_end};
use eos_domain::user_memory::lint_memory_text;
use regress::Regex;

use crate::ledger::candidate_scope;

pub const DREAM_CHAT_CHARS: usize = 24_000;
const AGENT_LINE_CHARS: usize = 600;
const DAY_MS: i64 = 24 * 60 * 60_000;

// ---- schedule ---------------------------------------------------------------

/// How far the user's clock is east of UTC at an instant, in minutes: the
/// zone's rules, summer time included.
pub type OffsetAt<'a> = &'a dyn Fn(i64) -> i32;

/// The user's wall-clock time at `at`, as milliseconds since 1970 on that clock.
pub fn wall_clock(at: i64, offset_at: OffsetAt<'_>) -> i64 {
    at + i64::from(offset_at(at)) * 60_000
}

/// The instant a wall-clock time names, as JavaScript's `Date` reads one: of
/// a time the clocks pass twice (when they go back) the first, and a time
/// they skip (when they go forward) as many minutes after the change as it
/// was after the skipped hour began.
pub fn instant_of(wall: i64, offset_at: OffsetAt<'_>) -> i64 {
    // The offsets in force around it: a zone changes at most once a day.
    let (before, after) = (offset_at(wall - DAY_MS), offset_at(wall + DAY_MS));
    let fits = |offset: i32| {
        let at = wall - i64::from(offset) * 60_000;
        (offset_at(at) == offset).then_some(at)
    };
    match (fits(before), fits(after)) {
        (Some(a), Some(b)) => a.min(b),
        (Some(at), None) | (None, Some(at)) => at,
        (None, None) => wall - i64::from(before) * 60_000,
    }
}

/// The most recent `HH:MM` on the user's clock at or before `now`.
pub fn nightly_slot(now: i64, nightly_at: &str, offset_at: OffsetAt<'_>) -> i64 {
    let mut parts = nightly_at.split(':').map(|part| part.parse::<i64>().ok());
    let (hours, minutes) = (parts.next().flatten().unwrap_or(3), parts.next().flatten().unwrap_or(0));
    let midnight = wall_clock(now, offset_at).div_euclid(DAY_MS) * DAY_MS;
    let wall = midnight + hours * 3_600_000 + minutes * 60_000;
    let slot = instant_of(wall, offset_at);
    if slot > now { instant_of(wall - DAY_MS, offset_at) } else { slot }
}

/// The same time on the user's clock a day after the latest slot: 23 or 25
/// hours later on the nights the clocks change.
pub fn next_nightly(now: i64, nightly_at: &str, offset_at: OffsetAt<'_>) -> i64 {
    let slot = nightly_slot(now, nightly_at, offset_at);
    instant_of(wall_clock(slot, offset_at) + DAY_MS, offset_at)
}

/// Due once the clock passed tonight's slot and nothing started since: a
/// computer asleep at 03:00 dreams when it wakes. `since` is the last run's
/// start, or when dreaming was switched on (switching it on in the afternoon
/// does not dream at once).
pub fn is_nightly_due(now: i64, nightly_at: &str, since: i64, offset_at: OffsetAt<'_>) -> bool {
    since < nightly_slot(now, nightly_at, offset_at)
}

/// Away: no user message for `away_minutes`, nothing working, and no dream
/// yet since the user was last active — one dream per away stretch.
pub fn is_away_due(now: i64, away_minutes: i64, last_user_at: i64, any_working: bool, last_started_at: i64) -> bool {
    !any_working && now - last_user_at >= away_minutes * 60_000 && last_started_at < last_user_at
}

// ---- which chats ------------------------------------------------------------

/// A top-level chat — where the user talks — as a dream sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamSession {
    pub worker_id: String,
    pub name: String,
    pub project: Option<String>,
    pub no_folder: bool,
    pub working: bool,
    pub last_event_id: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ChatFilter {
    pub max_chats: usize,
    pub excluded_projects: Vec<String>,
    pub include_no_folder: bool,
    pub excluded_chats: HashSet<String>,
    /// The last event of each chat a dream has read.
    pub watermarks: HashMap<String, i64>,
}

/// Finished chats with something new since the last dream, newest first.
pub fn pick_chats(sessions: Vec<DreamSession>, filter: &ChatFilter) -> Vec<DreamSession> {
    let excluded_project = |project: Option<&str>| {
        project.is_some_and(|p| {
            filter.excluded_projects.iter().any(|x| p == x || p.starts_with(&format!("{}/", x.trim_end_matches('/'))))
        })
    };
    let mut picked: Vec<DreamSession> = sessions
        .into_iter()
        .filter(|s| !s.working && !filter.excluded_chats.contains(&s.worker_id))
        .filter(|s| if s.no_folder { filter.include_no_folder } else { !excluded_project(s.project.as_deref()) })
        .filter(|s| s.last_event_id > filter.watermarks.get(&s.worker_id).copied().unwrap_or(0))
        .collect();
    picked.sort_by_key(|s| std::cmp::Reverse(s.last_event_id));
    picked.truncate(filter.max_chats);
    picked
}

// ---- secrets ----------------------------------------------------------------

fn secret_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let patterns: [(&str, &str); 8] = [
            (r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}", ""),
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}", ""),
            (r"\bgithub_pat_[A-Za-z0-9_]{20,}", ""),
            (r"\bAKIA[0-9A-Z]{16}\b", ""),
            (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", ""),
            (r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", ""),
            (r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", ""),
            (r"\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}", "i"),
        ];
        patterns.iter().filter_map(|(pattern, flags)| Regex::with_flags(pattern, *flags).ok()).collect()
    })
}

pub fn looks_secret(text: &str) -> bool {
    secret_patterns().iter().any(|re| re.find(text).is_some())
}

pub fn scrub_secrets(text: &str) -> String {
    let mut scrubbed = text.to_owned();
    for re in secret_patterns() {
        let mut out = String::with_capacity(scrubbed.len());
        let mut from = 0;
        for found in re.find_iter(&scrubbed) {
            out.push_str(&scrubbed[from..found.start()]);
            out.push_str("[redacted]");
            from = found.end();
        }
        if from > 0 {
            out.push_str(&scrubbed[from..]);
            scrubbed = out;
        }
    }
    scrubbed
}

// ---- rendering --------------------------------------------------------------

/// One thing said in a chat: by the user, or by the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamLine {
    /// The event's row.
    pub id: i64,
    pub by_user: bool,
    pub text: String,
    /// When it was said.
    pub at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct RenderedChat {
    pub text: String,
    pub user_turns: i64,
    /// Row → the scrubbed line, for turning evidence ids back into quotes.
    pub lines: HashMap<i64, DreamLine>,
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text` cut to `max` UTF-16 units, with an ellipsis when something is missing.
pub(crate) fn clip(text: &str, max: usize) -> String {
    if units(text) <= max {
        return text.to_owned();
    }
    let mut used = 0;
    let cut: String = text
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= max
        })
        .collect();
    format!("{}…", js_trim_end(&cut))
}

/// The user's words in full, the agent's trimmed. Over budget, the oldest lines go first.
pub fn render_chat_for_dream(messages: &[DreamLine], budget: usize) -> RenderedChat {
    let mut kept: Vec<(DreamLine, String)> = Vec::new();
    let mut used = 0;
    for message in messages.iter().rev() {
        let raw = scrub_secrets(js_trim(&message.text));
        if raw.is_empty() {
            continue;
        }
        let body = clip(&raw, if message.by_user { budget } else { AGENT_LINE_CHARS });
        let rendered = format!("[e{}] {}: {body}", message.id, if message.by_user { "USER" } else { "AGENT" });
        if used + units(&rendered) > budget && !kept.is_empty() {
            break;
        }
        used += units(&rendered) + 1;
        kept.push((DreamLine { text: body, ..message.clone() }, rendered));
    }
    kept.reverse();
    RenderedChat {
        text: kept.iter().map(|(_, rendered)| rendered.as_str()).collect::<Vec<_>>().join("\n"),
        user_turns: kept.iter().filter(|(line, _)| line.by_user).count() as i64,
        lines: kept.into_iter().map(|(line, _)| (line.id, line)).collect(),
    }
}

// ---- which signals can become memories ----------------------------------------

pub fn empty_dropped() -> DreamDropped {
    DreamDropped {
        one_off: 0,
        known: 0,
        declined: 0,
        secret: 0,
        weak: 0,
        invalid: 0,
        product: 0,
        task_bound: 0,
        choice: 0,
        critic: 0,
        style: 0,
        capped: 0,
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SignalFilter {
    pub kept: Vec<DreamSignal>,
    pub product: i64,
    pub task_bound: i64,
    pub choice: i64,
}

/// Only how the agent should work with the user, or who the user is. What
/// the product does belongs to the code and docs; one task's step belongs to
/// that task; accepting an option the agent offered says nothing about the user.
pub fn filter_signals(signals: Vec<DreamSignal>) -> SignalFilter {
    let mut out = SignalFilter::default();
    for signal in signals {
        let product = matches!(signal.object, DreamSignalObject::Artifact | DreamSignalObject::ProjectConvention)
            || signal.stance == DreamSignalStance::ProductFeedback;
        match signal.stance {
            _ if product => out.product += 1,
            DreamSignalStance::TaskInstruction => out.task_bound += 1,
            DreamSignalStance::Choice => out.choice += 1,
            _ => out.kept.push(signal),
        }
    }
    out
}

// ---- proposals ------------------------------------------------------------------

/// A proposal that can be applied: a ready candidate behind it, targets that
/// exist and are kept, and the scope it lands in.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedProposal {
    pub draft: DreamProposalDraft,
    pub candidate: DreamCandidate,
    pub scope: UserMemoryScope,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProposalCheck {
    pub accepted: Vec<CheckedProposal>,
    pub invalid: i64,
    pub secret: i64,
    pub style: i64,
    pub rejected: Vec<DreamRejected>,
}

fn unique(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter().filter(|id| seen.insert(id.as_str())).cloned().collect()
}

fn scope_for(
    draft: &DreamProposalDraft,
    candidate: &DreamCandidate,
    kept: &HashMap<&str, &UserMemory>,
) -> Option<UserMemoryScope> {
    let targets: Option<Vec<&UserMemory>> =
        unique(&draft.targets).iter().map(|id| kept.get(id.as_str()).copied()).collect();
    let targets = targets?;
    let project_of = |scope: &UserMemoryScope| match scope {
        UserMemoryScope::Project(project) => Some(project.path.clone()),
        UserMemoryScope::Global => None,
    };
    match draft.kind {
        DreamProposalKind::New => Some(candidate_scope(candidate)),
        DreamProposalKind::Update | DreamProposalKind::Retire => (targets.len() == 1).then(|| targets[0].scope.clone()),
        DreamProposalKind::Promote => {
            (targets.len() == 1 && project_of(&targets[0].scope).is_some()).then_some(UserMemoryScope::Global)
        }
        DreamProposalKind::Merge => {
            if targets.len() < 2 {
                return None;
            }
            let first = &targets[0].scope;
            let same = targets.iter().all(|m| project_of(&m.scope) == project_of(first));
            Some(if same { first.clone() } else { UserMemoryScope::Global })
        }
    }
}

/// What each proposal needs to be applied safely; a new memory's scope comes
/// from where its support was seen.
pub fn check_proposals(
    drafts: &[DreamProposalDraft],
    memories: &[UserMemory],
    ready: &[DreamCandidate],
) -> ProposalCheck {
    let kept: HashMap<&str, &UserMemory> =
        memories.iter().filter(|m| m.status == UserMemoryStatus::Active).map(|m| (m.id.0.as_str(), m)).collect();
    let mut check = ProposalCheck::default();
    for draft in drafts {
        let Some(candidate) = ready.iter().find(|c| c.id == draft.candidate) else {
            check.invalid += 1;
            continue;
        };
        if looks_secret(&draft.text) {
            check.secret += 1;
            continue;
        }
        let lint = if draft.kind == DreamProposalKind::Retire { None } else { lint_memory_text(&draft.text) };
        if let Some(lint) = lint {
            check.style += 1;
            check.rejected.push(DreamRejected { text: draft.text.clone(), reason: format!("Writing: {lint}") });
            continue;
        }
        let Some(scope) = scope_for(draft, candidate, &kept) else {
            check.invalid += 1;
            continue;
        };
        let targets = if draft.kind == DreamProposalKind::New { Vec::new() } else { unique(&draft.targets) };
        check.accepted.push(CheckedProposal { draft: draft.clone(), candidate: candidate.clone(), scope, targets });
    }
    check
}

/// The critic's five tests (`prompts/dream/critic-system`), by number.
const TEST_NAMES: [&str; 6] = [
    "",
    "about the product, not the user",
    "one task's step",
    "an agent would do it anyway",
    "not a well-written rule",
    "like something you declined",
];

fn refutation(verdict: Option<&DreamVerdict>, grounded: bool) -> String {
    let Some(verdict) = verdict else { return "The critic gave no verdict".to_owned() };
    if verdict.keep && !grounded {
        return "No cited line actually says it".to_owned();
    }
    let name = |n: &i64| usize::try_from(*n).ok().and_then(|n| TEST_NAMES.get(n)).filter(|name| !name.is_empty());
    let fails: Vec<&str> = verdict.fails.iter().filter_map(name).copied().collect();
    let fails = (!fails.is_empty()).then(|| format!("({})", fails.join("; ")));
    let parts: Vec<String> = Some(verdict.reason.clone()).filter(|r| !r.is_empty()).into_iter().chain(fails).collect();
    if parts.is_empty() { "Refuted".to_owned() } else { parts.join(" ") }
}

/// The critic must vouch for each proposal: kept only when it says so and at
/// least one cited line actually says it (a retire rests on the change, not a
/// quote). No verdict means refuted.
pub fn apply_verdicts(
    proposals: Vec<CheckedProposal>,
    verdicts: &[DreamVerdict],
) -> (Vec<CheckedProposal>, Vec<DreamRejected>) {
    let (mut kept, mut rejected) = (Vec::new(), Vec::new());
    for (i, proposal) in proposals.into_iter().enumerate() {
        let verdict = verdicts.iter().find(|v| usize::try_from(v.proposal) == Ok(i));
        let says = |v: &DreamVerdict| v.quotes.iter().any(|q| q.says == DreamVerdictQuotesItemSays::Yes);
        let grounded = proposal.draft.kind == DreamProposalKind::Retire || verdict.is_some_and(says);
        if verdict.is_some_and(|v| v.keep) && grounded {
            kept.push(proposal);
        } else {
            rejected.push(DreamRejected { text: proposal.draft.text, reason: refutation(verdict, grounded) });
        }
    }
    (kept, rejected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOUR: i64 = 3_600_000;
    /// 2026-03-10 00:00 UTC.
    const MIDNIGHT: i64 = 1_773_100_800_000;

    /// New York in 2026: summer time from 8 March 07:00 UTC (02:00 EST → 03:00
    /// EDT) to 1 November 06:00 UTC (02:00 EDT → 01:00 EST).
    fn new_york(at: i64) -> i32 {
        const SPRING: i64 = 1_772_953_200_000;
        const FALL: i64 = 1_793_512_800_000;
        if (SPRING..FALL).contains(&at) { -240 } else { -300 }
    }

    fn utc(iso: &str) -> i64 {
        eos_domain::time::ms_from_iso(iso).expect("a time")
    }

    #[test]
    fn the_nightly_slot_follows_the_clocks_when_they_go_forward() {
        let ny: OffsetAt<'_> = &new_york;
        // 01:30 that morning was still winter time, although "now" is summer time.
        let slot = nightly_slot(utc("2026-03-08T08:00:00.000Z"), "01:30", ny);
        assert_eq!(slot, utc("2026-03-08T06:30:00.000Z"));
        // From the night before, the next 03:00 is 23 hours later.
        let before = nightly_slot(utc("2026-03-07T12:00:00.000Z"), "03:00", ny);
        assert_eq!(before, utc("2026-03-07T08:00:00.000Z"));
        assert_eq!(next_nightly(utc("2026-03-07T12:00:00.000Z"), "03:00", ny), utc("2026-03-08T07:00:00.000Z"));
        // 02:30 never happens that night: as in JavaScript, it is 03:30 summer time.
        assert_eq!(nightly_slot(utc("2026-03-08T12:00:00.000Z"), "02:30", ny), utc("2026-03-08T07:30:00.000Z"));
        // Dreamed at 06:30 UTC: not due again that morning, due the next.
        let since = utc("2026-03-08T06:30:00.000Z");
        assert!(!is_nightly_due(utc("2026-03-08T12:00:00.000Z"), "01:30", since, ny));
        assert!(is_nightly_due(utc("2026-03-09T12:00:00.000Z"), "01:30", since, ny));
    }

    #[test]
    fn the_nightly_slot_follows_the_clocks_when_they_go_back() {
        let ny: OffsetAt<'_> = &new_york;
        // 00:30 that night was still summer time, although "now" is winter time.
        assert_eq!(nightly_slot(utc("2026-11-01T17:00:00.000Z"), "00:30", ny), utc("2026-11-01T04:30:00.000Z"));
        // From the night before, the next 03:00 is 25 hours later.
        assert_eq!(next_nightly(utc("2026-10-31T12:00:00.000Z"), "03:00", ny), utc("2026-11-01T08:00:00.000Z"));
        // 01:30 happens twice that night: as in JavaScript, the first.
        assert_eq!(nightly_slot(utc("2026-11-01T17:00:00.000Z"), "01:30", ny), utc("2026-11-01T05:30:00.000Z"));
    }

    #[test]
    fn a_signals_day_is_its_own_days_on_the_users_clock() {
        let ny: OffsetAt<'_> = &new_york;
        // 00:30 on 1 November, summer time; with winter time's offset it read as 31 October.
        assert_eq!(crate::ledger::day_key(utc("2026-11-01T04:30:00.000Z"), ny), "2026-11-01");
        assert_eq!(crate::ledger::day_key(utc("2026-11-01T04:30:00.000Z"), &|_| -300), "2026-10-31");
        // 23:30 on 7 March, winter time.
        assert_eq!(crate::ledger::day_key(utc("2026-03-08T04:30:00.000Z"), ny), "2026-03-07");
    }

    #[test]
    fn the_slot_is_tonights_once_passed_else_last_nights_on_the_users_clock() {
        assert_eq!(nightly_slot(MIDNIGHT + 4 * HOUR, "03:00", &|_| 0), MIDNIGHT + 3 * HOUR);
        assert_eq!(nightly_slot(MIDNIGHT + 2 * HOUR, "03:00", &|_| 0), MIDNIGHT - 21 * HOUR);
        assert_eq!(next_nightly(MIDNIGHT + 4 * HOUR, "03:00", &|_| 0), MIDNIGHT + 27 * HOUR);
        // Three hours east of UTC, 03:00 is midnight UTC.
        assert_eq!(nightly_slot(MIDNIGHT + HOUR, "03:00", &|_| 180), MIDNIGHT);
        // Due once per slot; a computer asleep at 03:00 dreams when it wakes.
        assert!(is_nightly_due(MIDNIGHT + 9 * HOUR, "03:00", MIDNIGHT - 10 * HOUR, &|_| 0));
        assert!(!is_nightly_due(MIDNIGHT + 9 * HOUR, "03:00", MIDNIGHT + 4 * HOUR, &|_| 0));
        assert!(!is_nightly_due(MIDNIGHT + 2 * HOUR, "03:00", MIDNIGHT - 20 * HOUR, &|_| 0));
    }

    #[test]
    fn away_is_idle_long_enough_nothing_working_once_per_stretch() {
        let minute = 60_000;
        assert!(is_away_due(100 * minute, 30, 60 * minute, false, 10 * minute));
        assert!(!is_away_due(80 * minute, 30, 60 * minute, false, 10 * minute), "not long enough");
        assert!(!is_away_due(100 * minute, 30, 60 * minute, true, 10 * minute), "something is working");
        assert!(!is_away_due(100 * minute, 30, 60 * minute, false, 70 * minute), "already dreamt this stretch");
    }

    fn session(id: &str, project: Option<&str>, last: i64) -> DreamSession {
        DreamSession {
            worker_id: id.into(),
            name: id.into(),
            project: project.map(str::to_owned),
            no_folder: project.is_none(),
            working: false,
            last_event_id: last,
        }
    }

    #[test]
    fn finished_chats_with_something_new_are_picked_newest_first() {
        let mut working = session("busy", Some("/p"), 90);
        working.working = true;
        let sessions = vec![
            session("old", Some("/p"), 10),
            session("new", Some("/p/sub"), 50),
            session("secret", Some("/private/x"), 60),
            session("bare", None, 70),
            session("read", Some("/p"), 30),
            session("off", Some("/p"), 80),
            working,
        ];
        let filter = ChatFilter {
            max_chats: 2,
            excluded_projects: vec!["/private/".into()],
            include_no_folder: false,
            excluded_chats: HashSet::from(["off".to_owned()]),
            watermarks: HashMap::from([("read".to_owned(), 30)]),
        };
        let picked: Vec<String> = pick_chats(sessions.clone(), &filter).into_iter().map(|s| s.worker_id).collect();
        assert_eq!(picked, ["new", "old"]);
        let all = ChatFilter { max_chats: 9, include_no_folder: true, ..ChatFilter::default() };
        assert_eq!(pick_chats(sessions, &all)[0].worker_id, "off");
    }

    fn line(id: i64, by_user: bool, text: &str) -> DreamLine {
        DreamLine { id, by_user, text: text.into(), at: id * 1000 }
    }

    #[test]
    fn a_chat_is_tagged_with_event_ids_keeps_the_users_words_and_trims_the_agents() {
        let agent = "a".repeat(700);
        let chat = [line(1, true, "  always run tests  "), line(2, false, &agent), line(3, true, "   ")];
        let rendered = render_chat_for_dream(&chat, DREAM_CHAT_CHARS);
        assert_eq!(rendered.user_turns, 1);
        assert!(rendered.text.starts_with("[e1] USER: always run tests\n[e2] AGENT: aaa"), "{}", rendered.text);
        assert!(rendered.text.ends_with('…') && rendered.lines[&2].text.chars().count() == 601);
        // Over budget, the oldest lines go first.
        let long = [line(1, true, &"x".repeat(80)), line(2, true, &"y".repeat(80)), line(3, true, "last")];
        let tight = render_chat_for_dream(&long, 120);
        assert!(!tight.text.contains("[e1]") && tight.text.ends_with("[e3] USER: last"), "{}", tight.text);
    }

    #[test]
    fn secrets_are_recognised_and_scrubbed() {
        // Built here: a key written out in a source file is what scanners look for.
        let key = format!("sk-{}-{}", "ant", "x".repeat(20));
        let text = format!("use {key} and password = hunter2222 ok");
        assert!(looks_secret(&text) && !looks_secret("the token budget is fine"));
        assert_eq!(scrub_secrets(&text), "use [redacted] and [redacted] ok");
        let hub = format!("{}_{}!", "ghp", "A".repeat(24));
        assert_eq!(scrub_secrets(&hub), "[redacted]!");
        assert_eq!(scrub_secrets("nothing here"), "nothing here");
    }

    fn signal(object: &str, stance: &str) -> DreamSignal {
        serde_json::from_value(json!({"ask": "x", "object": object, "stance": stance, "evidence": [1]}))
            .expect("a signal")
    }

    #[test]
    fn the_product_one_tasks_steps_and_accepted_options_are_dropped() {
        let filtered = filter_signals(vec![
            signal("agent-behaviour", "general-rule"),
            signal("user-fact", "process-correction"),
            signal("artifact", "general-rule"),
            signal("project-convention", "general-rule"),
            signal("agent-behaviour", "product-feedback"),
            signal("agent-behaviour", "task-instruction"),
            signal("agent-behaviour", "choice"),
        ]);
        assert_eq!((filtered.kept.len(), filtered.product, filtered.task_bound, filtered.choice), (2, 3, 1, 1));
    }

    fn memory(id: &str, scope: serde_json::Value, status: &str) -> UserMemory {
        serde_json::from_value(json!({
            "id": id, "text": "When done, say so.", "category": "work-style", "scope": scope, "tier": "always",
            "status": status, "source": {"kind": "user"}, "rev": 1, "createdAt": 1, "updatedAt": 1,
        }))
        .expect("a memory")
    }

    fn candidate(id: &str, project: Option<&str>) -> DreamCandidate {
        serde_json::from_value(json!({
            "id": id, "claim": "c", "object": "agent-behaviour", "target": null, "firstSeen": 1, "lastSeen": 1,
            "support": [{"workerId": "w1", "chat": "c", "project": project, "day": "2026-03-10", "at": 1,
                         "stance": "general-rule", "marker": "always", "reason": null, "irreversible": false, "evidence": []}],
        }))
        .expect("a candidate")
    }

    fn draft(kind: &str, text: &str, targets: &[&str]) -> DreamProposalDraft {
        serde_json::from_value(json!({"candidate": "dc-1", "kind": kind, "text": text, "category": "work-style",
            "domain": "code", "targets": targets, "why": "w"}))
        .expect("a draft")
    }

    #[test]
    fn each_proposal_needs_a_ready_candidate_kept_targets_good_writing_and_a_scope() {
        let project = json!({"kind": "project", "path": "/p"});
        let memories = [
            memory("um-000000000001", project.clone(), "active"),
            memory("um-000000000002", json!({"kind": "global"}), "active"),
            memory("um-000000000003", project, "dismissed"),
        ];
        let ready = [candidate("dc-1", Some("/p"))];
        let good = "When a change is done, run the tests first.";
        let drafts = [
            draft("new", good, &[]),
            draft("update", good, &["um-000000000001"]),
            draft("promote", good, &["um-000000000001"]),
            draft("merge", good, &["um-000000000001", "um-000000000002"]),
            draft("retire", "anything goes", &["um-000000000002"]),
            draft("promote", good, &["um-000000000002"]),
            draft("update", good, &["um-000000000003"]),
            draft("merge", good, &["um-000000000001"]),
            draft("new", "The user usually wants tests.", &[]),
            draft("new", &format!("When done, use {} = {}.", "token", "v".repeat(12)), &[]),
        ];
        let check = check_proposals(&drafts, &memories, &ready);
        let scopes: Vec<bool> = check.accepted.iter().map(|p| p.scope == UserMemoryScope::Global).collect();
        assert_eq!(scopes, [false, false, true, true, true], "new and update stay in the project");
        assert_eq!((check.invalid, check.style, check.secret), (3, 1, 1));
        let mut other = draft("new", good, &[]);
        other.candidate = "dc-9".into();
        assert_eq!(check_proposals(&[other], &memories, &ready).invalid, 1, "no ready candidate behind it");
    }

    #[test]
    fn the_critic_must_vouch_keep_and_a_quote_that_says_it() {
        let drafts = vec![draft("new", "When done, run tests.", &[]); 4];
        let check = check_proposals(&drafts, &[], &[candidate("dc-1", None)]);
        let verdicts: Vec<DreamVerdict> = serde_json::from_value(json!([
            {"proposal": 0, "keep": true, "quotes": [{"eventId": 1, "says": "yes"}]},
            {"proposal": 1, "keep": true, "quotes": [{"eventId": 1, "says": "topical"}]},
            {"proposal": 2, "keep": false, "fails": [1, 4], "reason": "Describes the app"},
        ]))
        .expect("verdicts");
        let (kept, rejected) = apply_verdicts(check.accepted, &verdicts);
        assert_eq!(kept.len(), 1);
        let reasons: Vec<&str> = rejected.iter().map(|r| r.reason.as_str()).collect();
        assert_eq!(
            reasons,
            [
                "No cited line actually says it",
                "Describes the app (about the product, not the user; not a well-written rule)",
                "The critic gave no verdict",
            ]
        );
    }
}
