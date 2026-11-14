//! Why a route to another computer failed, in words a person can act on
//! (`manager/peer/dial-failure.ts`). The error code is what separates "macOS
//! keeps Eos off the local network" from "nothing listens there" and "the
//! relay is out of reach from this network".

use eos_contracts::LinkRoute;

/// The codes a link's status carries in `error`; the dashboard maps them to copy.
pub mod link_error {
    pub const IDENTITY_CHANGED: &str = "identity-changed";
    pub const NOT_PAIRED: &str = eos_contracts::peer_refusal::NOT_PAIRED;
    pub const HOSTING_OFF: &str = eos_contracts::peer_refusal::HOSTING_OFF;
    pub const NO_ROUTE: &str = "no-route";
    pub const UNREACHABLE: &str = "unreachable";
    /// A direct path failed with "no route to host": most often macOS Local
    /// Network privacy keeping Eos off the LAN.
    pub const LOCAL_NETWORK: &str = "local-network";
    /// This run of Eos dials no host at all.
    pub const OFF_NETWORK: &str = eos_contracts::OFF_NETWORK;
}

/// One failed attempt: the route it tried and the system's error name
/// (`ECONNREFUSED`), the relay's refusal code, or `UNKNOWN`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialFailure {
    pub route: LinkRoute,
    pub code: String,
}

impl DialFailure {
    pub fn new(route: LinkRoute, code: impl Into<String>) -> Self {
        Self { route, code: code.into() }
    }
}

// macOS Local Network privacy fails a LAN connect at once with "no route to host".
fn no_lan_route(code: &str) -> bool {
    matches!(code, "EHOSTUNREACH" | "ENETUNREACH")
}

pub fn blocked_from_local_network(failures: &[DialFailure]) -> bool {
    failures.iter().any(|f| f.route == LinkRoute::Direct && no_lan_route(&f.code))
}

fn explain(f: &DialFailure) -> (u8, &'static str) {
    match f.route {
        LinkRoute::Relay if f.code == "ROOM_NOT_FOUND" => (3, "it isn't on its relay right now"),
        LinkRoute::Relay => (3, "its relay can't be reached from this network"),
        LinkRoute::Reverse => (4, "its own link to this Mac dropped"),
        LinkRoute::Direct if no_lan_route(&f.code) => (
            0,
            "macOS may be keeping Eos off the local network — allow Eos in System Settings › Privacy & Security › Local Network",
        ),
        LinkRoute::Direct if f.code == "ECONNREFUSED" => {
            (1, "nothing answered at its address — is Eos running there with Direct on?")
        }
        LinkRoute::Direct if f.code == "EHOSTDOWN" => (2, "it isn't on this network"),
        LinkRoute::Direct => (2, "its address didn't answer — a firewall on that Mac, or you're on different networks"),
    }
}

/// Each distinct cause once, the one most worth acting on first.
pub fn explain_dial_failures(failures: &[DialFailure]) -> String {
    let mut reasons: Vec<(u8, &str)> = failures.iter().map(explain).collect();
    reasons.sort_by_key(|(rank, _)| *rank);
    let mut said: Vec<&str> = Vec::new();
    for (_, text) in reasons {
        if !said.contains(&text) {
            said.push(text);
        }
    }
    said.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(route: LinkRoute, code: &str) -> DialFailure {
        DialFailure::new(route, code)
    }

    // manager/peer/__tests__/dial-failure.test.ts
    #[test]
    fn puts_the_local_network_hint_first_and_says_each_cause_once() {
        let text = explain_dial_failures(&[
            failure(LinkRoute::Relay, "TIMEOUT"),
            failure(LinkRoute::Direct, "EHOSTUNREACH"),
            failure(LinkRoute::Direct, "EHOSTUNREACH"),
        ]);
        assert!(text.starts_with("macOS may be keeping Eos off the local network"), "{text}");
        assert_eq!(text.matches("Local Network").count(), 1);
        assert!(text.ends_with("relay can't be reached from this network"), "{text}");
    }

    #[test]
    fn blames_local_network_privacy_only_for_a_direct_no_route() {
        assert!(blocked_from_local_network(&[failure(LinkRoute::Direct, "EHOSTUNREACH")]));
        assert!(blocked_from_local_network(&[failure(LinkRoute::Direct, "ENETUNREACH")]));
        assert!(!blocked_from_local_network(&[failure(LinkRoute::Direct, "ECONNREFUSED")]));
        assert!(!blocked_from_local_network(&[failure(LinkRoute::Relay, "EHOSTUNREACH")]));
    }

    #[test]
    fn every_route_has_its_own_words() {
        assert_eq!(
            explain_dial_failures(&[
                failure(LinkRoute::Reverse, "UNKNOWN"),
                failure(LinkRoute::Relay, "ROOM_NOT_FOUND"),
                failure(LinkRoute::Direct, "EHOSTDOWN"),
                failure(LinkRoute::Direct, "ECONNREFUSED"),
                failure(LinkRoute::Direct, "ETIMEDOUT"),
            ]),
            "nothing answered at its address — is Eos running there with Direct on?; it isn't on this network; \
             its address didn't answer — a firewall on that Mac, or you're on different networks; \
             it isn't on its relay right now; its own link to this Mac dropped"
        );
        assert_eq!(explain_dial_failures(&[]), "");
    }
}
