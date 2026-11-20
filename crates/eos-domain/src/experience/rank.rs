//! How recalled notes rank, which one wins when two disagree, and the bars a
//! note must pass to be delivered. Every constant recall is tuned by lives
//! here.

use std::cmp::Ordering;

use super::note::{NoteState, Scope, Trust};

const W_MATCH: f64 = 0.45;
const W_SPREAD: f64 = 0.20;
const W_ACTIVATION: f64 = 0.15;
const W_STRENGTH: f64 = 0.20;
const COOLING_FACTOR: f64 = 0.5;

/// A reminder at the moment needs this score; a trying note needs more.
pub const REMINDER_THRESHOLD: f64 = 0.55;
pub const REMINDER_THRESHOLD_TRYING: f64 = 0.65;
/// A note rides in a pack at this score.
pub const PACK_THRESHOLD: f64 = 0.35;

/// Ranking weight of a note's trust.
pub fn trust_factor(trust: Trust) -> f64 {
    match trust {
        Trust::Said => 1.0,
        Trust::Did => 0.9,
        Trust::Outcome => 0.85,
        Trust::Guess => 0.7,
    }
}

/// What one recalled note brings to its ranking, each part in 0..=1.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate<'a> {
    /// How well the note's hooks, words and meaning match the cues.
    pub matched: f64,
    /// The activation that reached it through links.
    pub spread: f64,
    /// How recently and often it was used.
    pub activation: f64,
    pub strength: f64,
    pub scope: &'a Scope,
    pub trust: Trust,
    pub state: NoteState,
}

/// `0.45·match + 0.20·spread + 0.15·activation + 0.20·strength`, weighed by
/// scope and trust, halved while cooling.
pub fn score(c: &Candidate<'_>) -> f64 {
    let base = W_MATCH * c.matched + W_SPREAD * c.spread + W_ACTIVATION * c.activation + W_STRENGTH * c.strength;
    let cooling = if c.state == NoteState::Cooling { COOLING_FACTOR } else { 1.0 };
    base * c.scope.factor() * trust_factor(c.trust) * cooling
}

/// The score a note needs to come as a reminder at the moment.
pub fn reminder_threshold(state: NoteState) -> f64 {
    if state == NoteState::Trying { REMINDER_THRESHOLD_TRYING } else { REMINDER_THRESHOLD }
}

/// What decides between two notes that match and disagree.
#[derive(Debug, Clone, PartialEq)]
pub struct Contender<'a> {
    pub id: &'a str,
    pub scope: &'a Scope,
    pub trust: Trust,
    pub updated_at: i64,
    /// The note this one replaced, if any.
    pub replaces: Option<&'a str>,
}

/// Which of two disagreeing notes is delivered (`Ordering::Less`: `a` wins).
/// A successor beats what it replaced; then the narrower scope; then the
/// higher trust; then the newer change; the id makes it total.
pub fn prefer(a: &Contender<'_>, b: &Contender<'_>) -> Ordering {
    if a.replaces == Some(b.id) {
        return Ordering::Less;
    }
    if b.replaces == Some(a.id) {
        return Ordering::Greater;
    }
    a.scope
        .level
        .cmp(&b.scope.level)
        .then_with(|| trust_factor(b.trust).total_cmp(&trust_factor(a.trust)))
        .then_with(|| b.updated_at.cmp(&a.updated_at))
        .then_with(|| a.id.cmp(b.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::experience::note::ScopeLevel;

    fn scope(level: ScopeLevel) -> Scope {
        Scope { level, key: "k".into() }
    }

    #[test]
    fn the_score_weighs_its_parts_scope_trust_and_cooling() {
        let routine = scope(ScopeLevel::Routine);
        let full = Candidate {
            matched: 1.0,
            spread: 1.0,
            activation: 1.0,
            strength: 1.0,
            scope: &routine,
            trust: Trust::Said,
            state: NoteState::Firm,
        };
        assert!((score(&full) - 1.0).abs() < 1e-9);
        let only_match = Candidate { spread: 0.0, activation: 0.0, strength: 0.0, ..full.clone() };
        assert!((score(&only_match) - 0.45).abs() < 1e-9);
        let everywhere = scope(ScopeLevel::Everywhere);
        let wide_guess = Candidate { scope: &everywhere, trust: Trust::Guess, ..full.clone() };
        assert!((score(&wide_guess) - 0.7 * 0.7).abs() < 1e-9);
        let cooling = Candidate { state: NoteState::Cooling, ..full };
        assert!((score(&cooling) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_trying_note_needs_a_higher_score_to_remind() {
        assert_eq!(reminder_threshold(NoteState::Firm), REMINDER_THRESHOLD);
        assert_eq!(reminder_threshold(NoteState::Trying), REMINDER_THRESHOLD_TRYING);
        assert!(PACK_THRESHOLD < REMINDER_THRESHOLD);
    }

    #[test]
    fn disagreeing_notes_resolve_by_successor_scope_trust_then_age() {
        let (narrow, wide) = (scope(ScopeLevel::Project), scope(ScopeLevel::Everywhere));
        let old = Contender { id: "mn-a", scope: &wide, trust: Trust::Said, updated_at: 1, replaces: None };
        let successor =
            Contender { id: "mn-b", scope: &wide, trust: Trust::Guess, updated_at: 0, replaces: Some("mn-a") };
        assert_eq!(prefer(&successor, &old), Ordering::Less);
        assert_eq!(prefer(&old, &successor), Ordering::Greater);

        let narrower = Contender { id: "mn-c", scope: &narrow, trust: Trust::Guess, updated_at: 0, replaces: None };
        assert_eq!(prefer(&narrower, &old), Ordering::Less, "narrower beats higher trust");

        let did = Contender { id: "mn-d", trust: Trust::Did, ..old.clone() };
        assert_eq!(prefer(&old, &did), Ordering::Less, "said beats did");

        let newer = Contender { id: "mn-e", updated_at: 9, ..old.clone() };
        assert_eq!(prefer(&newer, &old), Ordering::Less, "newer wins at equal scope and trust");
    }
}
