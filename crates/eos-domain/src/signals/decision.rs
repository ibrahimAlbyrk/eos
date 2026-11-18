//! What became of one signal for one routine (`signal_routes.decision`).
//! Every signal gets one per routine that could take it, so the counts the
//! user sees (handled, ignored, held back) add up.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Decision {
    /// A run was admitted for it.
    Run,
    /// It waits in the routine's open batch.
    Batched,
    /// A rule failed.
    Unmatched,
    /// A fact was missing, or the model could not be asked yet.
    Undecided,
    /// Undecided for a day.
    Unsorted,
    /// The routine's limits were full: kept, and run again by hand.
    OverLimit,
    /// A newer version of its subject came.
    Superseded,
    Paused,
    /// It was there when the source was first read.
    Baseline,
    /// Another computer holds the routine.
    Elsewhere,
    /// A development run starts nothing by itself.
    HeldDev,
    Refused,
    Cancelled,
}

impl Decision {
    pub const ALL: [Decision; 13] = [
        Decision::Run,
        Decision::Batched,
        Decision::Unmatched,
        Decision::Undecided,
        Decision::Unsorted,
        Decision::OverLimit,
        Decision::Superseded,
        Decision::Paused,
        Decision::Baseline,
        Decision::Elsewhere,
        Decision::HeldDev,
        Decision::Refused,
        Decision::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Run => "run",
            Decision::Batched => "batched",
            Decision::Unmatched => "unmatched",
            Decision::Undecided => "undecided",
            Decision::Unsorted => "unsorted",
            Decision::OverLimit => "over-limit",
            Decision::Superseded => "superseded",
            Decision::Paused => "paused",
            Decision::Baseline => "baseline",
            Decision::Elsewhere => "elsewhere",
            Decision::HeldDev => "held-dev",
            Decision::Refused => "refused",
            Decision::Cancelled => "cancelled",
        }
    }

    /// A stored decision; `None` for a word this version does not know.
    pub fn parse(text: &str) -> Option<Decision> {
        Decision::ALL.into_iter().find(|decision| decision.as_str() == text)
    }
}

#[cfg(test)]
mod tests {
    use super::Decision;

    #[test]
    fn every_decision_is_stored_as_its_word_and_read_back() {
        let words: Vec<&str> = Decision::ALL.iter().map(|d| d.as_str()).collect();
        assert_eq!(
            words,
            [
                "run",
                "batched",
                "unmatched",
                "undecided",
                "unsorted",
                "over-limit",
                "superseded",
                "paused",
                "baseline",
                "elsewhere",
                "held-dev",
                "refused",
                "cancelled",
            ]
        );
        for decision in Decision::ALL {
            assert_eq!(Decision::parse(decision.as_str()), Some(decision));
        }
        assert_eq!(Decision::parse("over_limit"), None);
    }
}
