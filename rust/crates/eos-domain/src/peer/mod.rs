//! One computer controlling another: the rules both ends share
//! (`core/src/domain/peer.ts`, `manager/peer/invite-codec.ts`,
//! `dial-failure.ts`, the view tokens of `facade.ts`).
//!
//! A computer's identity is its self-signed certificate; the certificate's
//! SHA-256 fingerprint (64 lower-case hex characters) is what both ends pin.
//! The "host" is the computer being controlled, a "device" one allowed to
//! control it; every Eos is both.

mod address;
mod device_id;
mod dial;
mod invite;
mod view_token;

pub use address::{Address, parse_address};
pub use device_id::{format_device_id, is_fingerprint, short_device_id};
pub use dial::{DialFailure, blocked_from_local_network, explain_dial_failures, link_error};
pub use invite::{
    InviteFormatError, InviteState, MAX_OPEN_INVITES, MAX_PAIR_FAILURES, OpenInvites, Redeemed, bearer_hash,
    decode_invite, encode_invite, invite_state, relay_join_bearer, secret_hash,
};
pub use view_token::{ViewTokens, view_token};

/// What a connecting computer may do, decided from its pinned fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerAdmission {
    /// A paired device: the whole dashboard plane.
    Trusted,
    /// Unknown, while an invite is open: it may only redeem one.
    PairingOnly,
    Refused,
}

pub fn admit_peer(trusted: bool, pairing_open: bool) -> PeerAdmission {
    if trusted {
        PeerAdmission::Trusted
    } else if pairing_open {
        PeerAdmission::PairingOnly
    } else {
        PeerAdmission::Refused
    }
}

/// Compares without stopping at the first difference.
pub(crate) fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paired_device_is_trusted_and_a_stranger_only_pairs_while_an_invite_is_open() {
        assert_eq!(admit_peer(true, false), PeerAdmission::Trusted);
        assert_eq!(admit_peer(true, true), PeerAdmission::Trusted);
        assert_eq!(admit_peer(false, true), PeerAdmission::PairingOnly);
        assert_eq!(admit_peer(false, false), PeerAdmission::Refused);
    }
}
