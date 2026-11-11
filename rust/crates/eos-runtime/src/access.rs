//! Who is calling, and what each kind of caller may reach.
//!
//! There are no sockets to judge by: every request arrives tagged with its
//! caller, and each route declares one [`Access`] rule. The rule is data, so
//! the same declaration answers "may the phone call this", "does it cross to a
//! paired computer" and "does it need the user's own window".

use std::sync::Arc;

/// Who sent a request. Set by whoever hands the request to the router (the
/// shell bridge, the phone gateway, the peer gateway), never by the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// A page in this computer's own window.
    Local(LocalCaller),
    /// The phone, through the relay.
    Phone {
        /// The highest tier this device may call.
        grant: Tier,
        /// Whether it may call routes that need the user's token (today's `mutate` capability).
        mutate: bool,
    },
    /// A paired computer, through the peer link.
    Peer {
        /// The device's certificate fingerprint.
        device: Arc<str>,
        /// The device vouched that its own dashboard made the request (its
        /// ui-token or this host's view token), not just any process there.
        human: bool,
    },
    /// Code inside the app calling its own routes (the state patcher, agent tools).
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalCaller {
    /// The dashboard: the request carried this computer's ui-token.
    Dashboard,
    /// A view that controls the paired computer `host`: it holds that host's
    /// view token, which counts only for that host's facade.
    HostView { host: Arc<str> },
    /// Anything else that can reach the window's origin: a sandboxed frame, a
    /// plugin's page, a preview.
    Untrusted,
}

impl Caller {
    pub const DASHBOARD: Caller = Caller::Local(LocalCaller::Dashboard);
    pub const UNTRUSTED: Caller = Caller::Local(LocalCaller::Untrusted);

    /// May this caller act on the paired computer `host` through the facade?
    /// The dashboard may act on any; a host view only on its own.
    pub fn is_human_for_host(&self, host: &str) -> bool {
        match self {
            Caller::Local(LocalCaller::Dashboard) | Caller::Internal => true,
            Caller::Local(LocalCaller::HostView { host: own }) => own.as_ref() == host,
            _ => false,
        }
    }

    /// The fingerprint of the paired computer that sent this, if one did.
    pub fn peer_device(&self) -> Option<&str> {
        match self {
            Caller::Peer { device, .. } => Some(device),
            _ => None,
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Caller::Local(LocalCaller::Dashboard) => "dashboard",
            Caller::Local(LocalCaller::HostView { .. }) => "host-view",
            Caller::Local(LocalCaller::Untrusted) => "untrusted",
            Caller::Phone { .. } => "phone",
            Caller::Peer { human: true, .. } => "peer-human",
            Caller::Peer { human: false, .. } => "peer",
            Caller::Internal => "internal",
        }
    }
}

/// The phone's capability tiers, lowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    /// Pure reads.
    Read,
    /// Mutations that cannot run code or reach outside.
    Low,
    /// Code execution or externally visible effects.
    High,
}

/// What a local caller needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalRule {
    /// Any page in the window, the token-less ones included.
    Open,
    /// Only the user's dashboard (today's `x-eos-ui-token` check).
    UiToken,
}

/// Whether a route crosses to a paired computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRule {
    /// Never forwarded (the local plane: pickers, peering, installs, …).
    LocalOnly,
    /// Crosses for the other computer's own dashboard.
    Human,
    /// Public by design, on the host too (`GET /api/host`, `GET /ui/*`).
    Open,
}

/// The phone's rule for a route it may call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhoneRule {
    pub tier: Tier,
    /// The gateway vouches for the user on this route (today: it supplies the ui-token).
    pub ui_token: bool,
}

/// One route's access rule. Start from the caller the route is for and widen:
///
/// ```
/// use eos_runtime::access::{Access, Tier};
/// let read = Access::open().phone(Tier::Read);          // GET /workers
/// let write = Access::ui_token().phone_user(Tier::High); // POST /fs/write
/// let picker = Access::open().local_only();              // GET /pick-file
/// let public = Access::open().peer_open();               // GET /api/host
/// # let _ = (read, write, picker, public);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Access {
    pub local: LocalRule,
    pub peer: PeerRule,
    /// `None`: the phone is refused.
    pub phone: Option<PhoneRule>,
}

impl Access {
    /// Any local page; a paired computer's dashboard; not the phone.
    pub const fn open() -> Self {
        Self { local: LocalRule::Open, peer: PeerRule::Human, phone: None }
    }

    /// The user's dashboard only (here or on a paired computer); not the phone.
    pub const fn ui_token() -> Self {
        Self { local: LocalRule::UiToken, peer: PeerRule::Human, phone: None }
    }

    /// Never crosses to a paired computer.
    pub const fn local_only(mut self) -> Self {
        self.peer = PeerRule::LocalOnly;
        self
    }

    /// Crosses even without the other computer's dashboard vouching.
    pub const fn peer_open(mut self) -> Self {
        self.peer = PeerRule::Open;
        self
    }

    /// The phone may call it at `tier`.
    pub const fn phone(mut self, tier: Tier) -> Self {
        self.phone = Some(PhoneRule { tier, ui_token: false });
        self
    }

    /// The phone may call it at `tier`, and the gateway vouches for the user.
    pub const fn phone_user(mut self, tier: Tier) -> Self {
        self.phone = Some(PhoneRule { tier, ui_token: true });
        self
    }
}

/// Why a caller was turned away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The route has no access rule: nobody outside the app reaches it.
    Undeclared,
    /// A paired computer asked for a route of the local plane.
    LocalOnly,
    /// A paired computer's request did not come from its dashboard.
    NeedsHuman,
    /// The phone asked for a route it has no rule for.
    PhoneRefused,
    /// The phone's grant is below the route's tier.
    PhoneTier,
    /// The phone lacks the capability for routes that need the user's token.
    PhoneCapability,
    /// The route needs the user's dashboard.
    UiToken,
}

/// The checks that decide whether a request crosses at all. They run before
/// the plugin switch, as today's gateways run before the route.
pub(crate) fn check_plane(rule: Option<&Access>, caller: &Caller) -> Result<(), Refusal> {
    if matches!(caller, Caller::Internal) {
        return Ok(());
    }
    let rule = rule.ok_or(Refusal::Undeclared)?;
    match caller {
        Caller::Internal | Caller::Local(_) => Ok(()),
        Caller::Peer { human, .. } => match rule.peer {
            PeerRule::LocalOnly => Err(Refusal::LocalOnly),
            PeerRule::Human if !human => Err(Refusal::NeedsHuman),
            PeerRule::Human | PeerRule::Open => Ok(()),
        },
        Caller::Phone { grant, mutate } => {
            let phone = rule.phone.ok_or(Refusal::PhoneRefused)?;
            if phone.ui_token && !mutate {
                Err(Refusal::PhoneCapability)
            } else if phone.tier > *grant {
                Err(Refusal::PhoneTier)
            } else {
                Ok(())
            }
        }
    }
}

/// Whether the request carries the user's authority on this route — what
/// `uiTokenOk(req)` answers today, once the gateways have added their token.
pub(crate) fn speaks_for_user(rule: Option<&Access>, caller: &Caller) -> bool {
    match caller {
        Caller::Internal | Caller::Local(LocalCaller::Dashboard) => true,
        Caller::Local(_) => false,
        Caller::Peer { human, .. } => *human,
        Caller::Phone { mutate, .. } => *mutate && rule.and_then(|r| r.phone).is_some_and(|p| p.ui_token),
    }
}

/// The user's-token gate. Runs after the plugin switch, as today's handlers
/// check the token after the switch let them run.
pub(crate) fn check_user(rule: Option<&Access>, caller: &Caller) -> Result<(), Refusal> {
    match rule {
        Some(Access { local: LocalRule::UiToken, .. }) if !speaks_for_user(rule, caller) => Err(Refusal::UiToken),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(human: bool) -> Caller {
        Caller::Peer { device: "ab".repeat(32).into(), human }
    }
    const PHONE: Caller = Caller::Phone { grant: Tier::High, mutate: true };

    fn verdict(rule: Option<Access>, caller: &Caller) -> Result<(), Refusal> {
        check_plane(rule.as_ref(), caller).and_then(|()| check_user(rule.as_ref(), caller))
    }

    #[test]
    fn a_route_without_a_rule_is_refused_to_everyone_outside_the_app() {
        for caller in [Caller::DASHBOARD, Caller::UNTRUSTED, peer(true), peer(false), PHONE] {
            assert_eq!(verdict(None, &caller), Err(Refusal::Undeclared), "{caller:?}");
        }
        assert_eq!(verdict(None, &Caller::Internal), Ok(()));
    }

    #[test]
    fn local_pages_need_the_token_only_where_the_route_says_so() {
        assert_eq!(verdict(Some(Access::open()), &Caller::UNTRUSTED), Ok(()));
        assert_eq!(verdict(Some(Access::ui_token()), &Caller::UNTRUSTED), Err(Refusal::UiToken));
        assert_eq!(verdict(Some(Access::ui_token()), &Caller::DASHBOARD), Ok(()));
        let view = Caller::Local(LocalCaller::HostView { host: "h1".into() });
        assert_eq!(verdict(Some(Access::ui_token()), &view), Err(Refusal::UiToken), "a view token is not the ui-token");
        assert!(view.is_human_for_host("h1"));
        assert!(!view.is_human_for_host("h2"));
        assert!(Caller::DASHBOARD.is_human_for_host("h2"));
        assert!(!Caller::UNTRUSTED.is_human_for_host("h1"));
    }

    #[test]
    fn the_local_plane_never_crosses_and_only_the_dashboard_crosses_the_rest() {
        assert_eq!(verdict(Some(Access::open().local_only()), &peer(true)), Err(Refusal::LocalOnly));
        assert_eq!(verdict(Some(Access::open()), &peer(false)), Err(Refusal::NeedsHuman));
        assert_eq!(verdict(Some(Access::open()), &peer(true)), Ok(()));
        assert_eq!(verdict(Some(Access::ui_token()), &peer(true)), Ok(()), "the host vouches for a human peer");
        assert_eq!(verdict(Some(Access::open().peer_open()), &peer(false)), Ok(()));
        assert_eq!(verdict(Some(Access::ui_token().peer_open()), &peer(false)), Err(Refusal::UiToken));
    }

    #[test]
    fn the_phone_reaches_only_what_lists_a_tier() {
        assert_eq!(verdict(Some(Access::open()), &PHONE), Err(Refusal::PhoneRefused));
        assert_eq!(verdict(Some(Access::open().phone(Tier::Low)), &PHONE), Ok(()));
        assert_eq!(verdict(Some(Access::ui_token().phone_user(Tier::High)), &PHONE), Ok(()));
        // A token-gated route listed without the token mark answers 403, as today.
        assert_eq!(verdict(Some(Access::ui_token().phone(Tier::High)), &PHONE), Err(Refusal::UiToken));
        let reader = Caller::Phone { grant: Tier::Read, mutate: true };
        assert_eq!(verdict(Some(Access::open().phone(Tier::Read)), &reader), Ok(()));
        assert_eq!(verdict(Some(Access::open().phone(Tier::Low)), &reader), Err(Refusal::PhoneTier));
        let no_mutate = Caller::Phone { grant: Tier::High, mutate: false };
        assert_eq!(verdict(Some(Access::ui_token().phone_user(Tier::High)), &no_mutate), Err(Refusal::PhoneCapability));
    }

    #[test]
    fn optional_token_routes_can_ask_who_speaks_for_the_user() {
        let rule = Access::open().phone_user(Tier::Read);
        assert!(speaks_for_user(Some(&rule), &PHONE));
        assert!(!speaks_for_user(Some(&Access::open().phone(Tier::Read)), &PHONE));
        assert!(speaks_for_user(Some(&rule), &peer(true)));
        assert!(!speaks_for_user(Some(&rule), &peer(false)));
        assert!(!speaks_for_user(Some(&rule), &Caller::UNTRUSTED));
    }
}
