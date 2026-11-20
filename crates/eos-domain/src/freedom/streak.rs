//! The streak that earns a routine more freedom (03 G3, D8): sends that went
//! out as Eos made them, counted back from the newest, and when one more rung
//! is offered.

use eos_contracts::Rung;

use super::rung::AUTOMATIC_RUNGS_LOCKED;

/// Sends in a row, unedited, that offer the next rung (D8).
pub const OFFER_AFTER: i64 = 10;
/// An automatic send counts once a day passed without an undo or "that was
/// wrong".
pub const AUTOMATIC_SETTLED_MS: i64 = 24 * 60 * 60 * 1000;

/// One of a routine's outcomes, as the streak reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counted<'a> {
    /// `sent_unedited`, `auto_sent`, `sent_edited`, … (`inbox_outcomes`).
    pub outcome: &'a str,
    pub at: i64,
}

/// The streak at `now` over `newest_first`: an unedited send counts, an
/// automatic one once it settled; an edit, a partial send, a discard, an
/// undo, "that was wrong" or a held flag ends it; the rest (expired,
/// replaced, an automatic send still settling) leave it as it is.
pub fn streak(newest_first: &[Counted<'_>], now: i64) -> i64 {
    let mut count = 0;
    for counted in newest_first {
        match counted.outcome {
            "sent_unedited" => count += 1,
            "auto_sent" | "auto_clean" if now - counted.at >= AUTOMATIC_SETTLED_MS => count += 1,
            "sent_edited" | "discarded" | "undone" | "wrong" | "held_flags" | "partial" => return count,
            _ => {}
        }
    }
    count
}

/// The rung above `rung`; none above "on its own".
pub fn next_rung(rung: Rung) -> Option<Rung> {
    match rung {
        Rung::Ask => Some(Rung::Draft),
        Rung::Draft => Some(Rung::SendThenTell),
        Rung::SendThenTell => Some(Rung::OnItsOwn),
        Rung::OnItsOwn => None,
    }
}

/// Where a routine stands with offers (`inbox_offers.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferState {
    None,
    Offered,
    /// "Not now": the streak counts again from then.
    Declined,
    /// "Never": no offer until the user changes Freedom by hand.
    Never,
}

impl OfferState {
    pub fn parse(word: &str) -> Self {
        match word {
            "offered" => Self::Offered,
            "declined" => Self::Declined,
            "never" => Self::Never,
            _ => Self::None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Offered => "offered",
            Self::Declined => "declined",
            Self::Never => "never",
        }
    }
}

/// The rung to offer, when one is due: a streak of [`OFFER_AFTER`], no open
/// offer and no "never", a rung above, and only a rung that sends without
/// the user while automatic sending is unlocked. Raising Ask to Draft needs
/// no unlock.
pub fn offer_due(streak: i64, state: OfferState, rung: Rung) -> Option<Rung> {
    if streak < OFFER_AFTER || matches!(state, OfferState::Offered | OfferState::Never) {
        return None;
    }
    let next = next_rung(rung)?;
    (next <= Rung::Draft || !AUTOMATIC_RUNGS_LOCKED).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = AUTOMATIC_SETTLED_MS;

    fn at(outcome: &str, at: i64) -> Counted<'_> {
        Counted { outcome, at }
    }

    #[test]
    fn unedited_sends_count_until_an_edit_and_the_neutral_ones_leave_it() {
        let now = 10 * DAY;
        let rows = [
            at("sent_unedited", now),
            at("expired", now),
            at("sent_unedited", now),
            at("sent_edited", now),
            at("sent_unedited", now),
        ];
        assert_eq!(streak(&rows, now), 2);
        for reset in ["discarded", "undone", "wrong", "held_flags"] {
            assert_eq!(streak(&[at(reset, now), at("sent_unedited", now)], now), 0, "{reset}");
        }
        assert_eq!(streak(&[at("replaced", now), at("sent_unedited", now)], now), 1);
    }

    #[test]
    fn an_automatic_send_counts_once_a_day_passed() {
        let now = 10 * DAY;
        assert_eq!(streak(&[at("auto_sent", now - DAY + 1)], now), 0, "still settling");
        assert_eq!(streak(&[at("auto_sent", now - DAY)], now), 1);
        assert_eq!(streak(&[at("wrong", now), at("auto_sent", now - 2 * DAY)], now), 0);
    }

    #[test]
    fn ten_in_a_row_offer_the_next_rung_once_unless_never() {
        let rung = Rung::Ask;
        assert_eq!(offer_due(OFFER_AFTER - 1, OfferState::None, rung), None);
        assert_eq!(offer_due(OFFER_AFTER, OfferState::None, rung), Some(Rung::Draft));
        assert_eq!(offer_due(OFFER_AFTER, OfferState::Declined, rung), Some(Rung::Draft));
        assert_eq!(offer_due(OFFER_AFTER, OfferState::Offered, rung), None, "one open offer");
        assert_eq!(offer_due(OFFER_AFTER, OfferState::Never, rung), None);
        assert_eq!(offer_due(OFFER_AFTER, OfferState::None, Rung::OnItsOwn), None, "nothing above");
        let automatic = offer_due(OFFER_AFTER, OfferState::None, Rung::Draft);
        assert_eq!(automatic, (!AUTOMATIC_RUNGS_LOCKED).then_some(Rung::SendThenTell), "only once unlocked");
    }
}
