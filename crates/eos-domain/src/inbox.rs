//! Needs you: the kinds of item that wait for the user, the states an item
//! moves through, how long each kind waits and how loudly it asks. Pure: no
//! store and no clock; times come in as arguments.

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemKind {
    /// A run's result held for the user to send.
    Draft,
    /// A triggered run of a routine at "ask" waits to start.
    RunStart,
    Question,
    /// A run worker's tool call asks.
    Permission,
    CapabilityInstall,
    /// A capability needs a sign-in, a setup step or a repair.
    CapabilityAttention,
    /// A suggestion for the user's profile.
    AboutYou,
    /// A routine paused, or needs the user before it goes on.
    RoutineAlert,
    /// A routine earned more freedom.
    FreedomOffer,
    /// The architect raised a routine's freedom or added a recipient.
    ConfirmChange,
    DeliveryProblem,
    /// The architect proposes a routine.
    Suggestion,
    Notice,
}

impl ItemKind {
    pub const ALL: [ItemKind; 13] = [
        ItemKind::Draft,
        ItemKind::RunStart,
        ItemKind::Question,
        ItemKind::Permission,
        ItemKind::CapabilityInstall,
        ItemKind::CapabilityAttention,
        ItemKind::AboutYou,
        ItemKind::RoutineAlert,
        ItemKind::FreedomOffer,
        ItemKind::ConfirmChange,
        ItemKind::DeliveryProblem,
        ItemKind::Suggestion,
        ItemKind::Notice,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Draft => "draft",
            ItemKind::RunStart => "run_start",
            ItemKind::Question => "question",
            ItemKind::Permission => "permission",
            ItemKind::CapabilityInstall => "capability_install",
            ItemKind::CapabilityAttention => "capability_attention",
            ItemKind::AboutYou => "about_you",
            ItemKind::RoutineAlert => "routine_alert",
            ItemKind::FreedomOffer => "freedom_offer",
            ItemKind::ConfirmChange => "confirm_change",
            ItemKind::DeliveryProblem => "delivery_problem",
            ItemKind::Suggestion => "suggestion",
            ItemKind::Notice => "notice",
        }
    }

    /// A stored kind; `None` for a word this version does not know.
    pub fn parse(text: &str) -> Option<ItemKind> {
        ItemKind::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// How long an item of this kind waits before it expires. `None` when
    /// something else ends it (a question with its run, a permission with its
    /// worker, a capability's attention when it works again, an about-you
    /// item with its suggestion, a routine alert when the routine resumes),
    /// and for a delivery problem, which waits until the user acts.
    pub fn lifetime_ms(self) -> Option<i64> {
        match self {
            ItemKind::Draft => Some(14 * DAY_MS),
            ItemKind::RunStart => Some(3 * DAY_MS),
            ItemKind::Notice => Some(7 * DAY_MS),
            ItemKind::CapabilityInstall | ItemKind::FreedomOffer | ItemKind::ConfirmChange | ItemKind::Suggestion => {
                Some(30 * DAY_MS)
            }
            ItemKind::Question
            | ItemKind::Permission
            | ItemKind::CapabilityAttention
            | ItemKind::AboutYou
            | ItemKind::RoutineAlert
            | ItemKind::DeliveryProblem => None,
        }
    }

    /// When an item of this kind made at `created_at` expires (epoch ms).
    pub fn expires_at(self, created_at: i64) -> Option<i64> {
        self.lifetime_ms().map(|lifetime| created_at + lifetime)
    }

    /// How loudly a new item of this kind asks. `by_hand`: the user started
    /// the run that made it, and is likely waiting for its draft.
    pub fn attention(self, by_hand: bool) -> Attention {
        match self {
            ItemKind::Draft if by_hand => Attention::Interrupt,
            ItemKind::Draft | ItemKind::RunStart | ItemKind::CapabilityInstall | ItemKind::Notice => Attention::Digest,
            ItemKind::Question
            | ItemKind::Permission
            | ItemKind::CapabilityAttention
            | ItemKind::RoutineAlert
            | ItemKind::DeliveryProblem => Attention::Interrupt,
            ItemKind::AboutYou | ItemKind::FreedomOffer | ItemKind::ConfirmChange | ItemKind::Suggestion => {
                Attention::Silent
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemState {
    Open,
    /// Put aside by the user until the next digest.
    Later,
    Answered,
    /// A newer result on the same subject took its place.
    Replaced,
    Expired,
    /// Its asker or its routine went away.
    Withdrawn,
}

impl ItemState {
    pub const ALL: [ItemState; 6] = [
        ItemState::Open,
        ItemState::Later,
        ItemState::Answered,
        ItemState::Replaced,
        ItemState::Expired,
        ItemState::Withdrawn,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ItemState::Open => "open",
            ItemState::Later => "later",
            ItemState::Answered => "answered",
            ItemState::Replaced => "replaced",
            ItemState::Expired => "expired",
            ItemState::Withdrawn => "withdrawn",
        }
    }

    /// A stored state; `None` for a word this version does not know.
    pub fn parse(text: &str) -> Option<ItemState> {
        ItemState::ALL.into_iter().find(|state| state.as_str() == text)
    }

    /// Still waiting for the user: listed, counted and answerable.
    pub fn is_waiting(self) -> bool {
        matches!(self, ItemState::Open | ItemState::Later)
    }

    /// Whether an item may move from this state to `next`. An item put aside
    /// still waits, so it ends the same ways an open one does; an item that
    /// ended never moves again.
    pub fn can_become(self, next: ItemState) -> bool {
        match (self, next) {
            (ItemState::Open, ItemState::Later) | (ItemState::Later, ItemState::Open) => true,
            (from, to) => from.is_waiting() && !to.is_waiting(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Attention {
    /// A banner and a phone push, at once.
    Interrupt,
    /// Counted in the next digest's banner.
    Digest,
    /// Listed and counted only.
    Silent,
}

impl Attention {
    pub const ALL: [Attention; 3] = [Attention::Interrupt, Attention::Digest, Attention::Silent];

    pub fn as_str(self) -> &'static str {
        match self {
            Attention::Interrupt => "interrupt",
            Attention::Digest => "digest",
            Attention::Silent => "silent",
        }
    }

    /// A stored level; `None` for a word this version does not know.
    pub fn parse(text: &str) -> Option<Attention> {
        Attention::ALL.into_iter().find(|level| level.as_str() == text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_states_and_levels_are_stored_as_their_words_and_read_back() {
        let kinds: Vec<&str> = ItemKind::ALL.iter().map(|kind| kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "draft",
                "run_start",
                "question",
                "permission",
                "capability_install",
                "capability_attention",
                "about_you",
                "routine_alert",
                "freedom_offer",
                "confirm_change",
                "delivery_problem",
                "suggestion",
                "notice",
            ]
        );
        let states: Vec<&str> = ItemState::ALL.iter().map(|state| state.as_str()).collect();
        assert_eq!(states, ["open", "later", "answered", "replaced", "expired", "withdrawn"]);
        let levels: Vec<&str> = Attention::ALL.iter().map(|level| level.as_str()).collect();
        assert_eq!(levels, ["interrupt", "digest", "silent"]);
        for kind in ItemKind::ALL {
            assert_eq!(ItemKind::parse(kind.as_str()), Some(kind));
        }
        for state in ItemState::ALL {
            assert_eq!(ItemState::parse(state.as_str()), Some(state));
        }
        for level in Attention::ALL {
            assert_eq!(Attention::parse(level.as_str()), Some(level));
        }
        assert_eq!(
            (ItemKind::parse("capability"), ItemState::parse("closed"), Attention::parse("loud")),
            (None, None, None)
        );
    }

    #[test]
    fn an_item_ends_once_from_open_or_later_and_moves_between_the_two() {
        use ItemState::{Answered, Expired, Later, Open, Replaced, Withdrawn};
        let allowed = [
            (Open, Later),
            (Open, Answered),
            (Open, Replaced),
            (Open, Expired),
            (Open, Withdrawn),
            (Later, Open),
            (Later, Answered),
            (Later, Replaced),
            (Later, Expired),
            (Later, Withdrawn),
        ];
        for from in ItemState::ALL {
            for to in ItemState::ALL {
                assert_eq!(from.can_become(to), allowed.contains(&(from, to)), "{from:?} → {to:?}");
            }
        }
        let waiting: Vec<ItemState> = ItemState::ALL.into_iter().filter(|state| state.is_waiting()).collect();
        assert_eq!(waiting, [Open, Later]);
    }

    #[test]
    fn each_kind_expires_after_its_own_time_or_with_what_ends_it() {
        use ItemKind::*;
        let day = 24 * 60 * 60 * 1000;
        let expected = [
            (Draft, Some(14 * day)),
            (RunStart, Some(3 * day)),
            (Question, None),
            (Permission, None),
            (CapabilityInstall, Some(30 * day)),
            (CapabilityAttention, None),
            (AboutYou, None),
            (RoutineAlert, None),
            (FreedomOffer, Some(30 * day)),
            (ConfirmChange, Some(30 * day)),
            (DeliveryProblem, None),
            (Suggestion, Some(30 * day)),
            (Notice, Some(7 * day)),
        ];
        assert_eq!(expected.map(|(kind, _)| kind), ItemKind::ALL);
        for (kind, lifetime) in expected {
            assert_eq!(kind.lifetime_ms(), lifetime, "{kind:?}");
            assert_eq!(kind.expires_at(1_000), lifetime.map(|ms| 1_000 + ms), "{kind:?}");
        }
    }

    #[test]
    fn each_kind_asks_at_its_own_level_and_a_draft_by_hand_interrupts() {
        use Attention::{Digest, Interrupt, Silent};
        use ItemKind::*;
        let expected = [
            (Draft, Digest),
            (RunStart, Digest),
            (Question, Interrupt),
            (Permission, Interrupt),
            (CapabilityInstall, Digest),
            (CapabilityAttention, Interrupt),
            (AboutYou, Silent),
            (RoutineAlert, Interrupt),
            (FreedomOffer, Silent),
            (ConfirmChange, Silent),
            (DeliveryProblem, Interrupt),
            (Suggestion, Silent),
            (Notice, Digest),
        ];
        assert_eq!(expected.map(|(kind, _)| kind), ItemKind::ALL);
        for (kind, level) in expected {
            assert_eq!(kind.attention(false), level, "{kind:?}");
            let by_hand = if kind == Draft { Interrupt } else { level };
            assert_eq!(kind.attention(true), by_hand, "{kind:?} by hand");
        }
    }
}
