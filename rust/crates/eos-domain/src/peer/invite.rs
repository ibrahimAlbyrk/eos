//! Invites: the link a person copies from the host's settings into the
//! device's "Connect a machine" sheet (`eos://pair/<base64url(JSON)>`), and
//! the host's list of the ones still open.
//!
//! An invite works once and never expires on its own, so only a few may be
//! open at a time and wrong guesses burn them all. The host keeps hashes
//! only: `sha256(secret)` to recognize the secret, and the hash of the relay
//! bearer derived from it, which admits the redeeming device to the relay room.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use eos_contracts::{OpenInvite, PEER_INVITE_PREFIX, PeerInvite};
use sha2::{Digest, Sha256};

use super::same_bytes;

pub const MAX_OPEN_INVITES: usize = 3;
/// Wrong secrets tolerated before every open invite is burned.
pub const MAX_PAIR_FAILURES: u32 = 5;

/// Node's decoder: padding optional, loose trailing bits accepted.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn encode_invite(invite: &PeerInvite) -> String {
    let json = serde_json::to_vec(invite).unwrap_or_default();
    format!("{PEER_INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(json))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteFormatError {
    NotAnInvite,
    Damaged,
    Incompatible,
}

impl std::fmt::Display for InviteFormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotAnInvite => "not an Eos invite link",
            Self::Damaged => "invite link is damaged — copy it again",
            Self::Incompatible => "invite link is from an incompatible Eos version",
        })
    }
}

impl std::error::Error for InviteFormatError {}

pub fn decode_invite(link: &str) -> Result<PeerInvite, InviteFormatError> {
    let encoded = link.trim().strip_prefix(PEER_INVITE_PREFIX).ok_or(InviteFormatError::NotAnInvite)?;
    // Node reads the standard alphabet too and skips what is neither.
    let cleaned: String = encoded
        .chars()
        .filter_map(|c| match c {
            '+' => Some('-'),
            '/' => Some('_'),
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect();
    let bytes = LENIENT.decode(cleaned).map_err(|_| InviteFormatError::Damaged)?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| InviteFormatError::Damaged)?;
    eos_contracts::parse(&json).map_err(|_| InviteFormatError::Incompatible)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteState {
    Valid,
    Expired,
}

/// Links from builds that expired invites carry `exp` (unix seconds).
pub fn invite_state(invite: &PeerInvite, now_ms: i64) -> InviteState {
    match invite.exp {
        Some(exp) if now_ms >= exp.saturating_mul(1000) => InviteState::Expired,
        _ => InviteState::Valid,
    }
}

/// `sha256(secret)` in hex: how the host remembers an invite.
pub fn secret_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// The bearer a device presents to the relay while it redeems an invite. The
/// relay sees it in the clear; deriving it keeps the secret itself inside TLS.
pub fn relay_join_bearer(invite_secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"eos-relay-join\0");
    hasher.update(invite_secret.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

/// What the relay stores of a bearer.
pub fn bearer_hash(bearer: &str) -> String {
    hex::encode(Sha256::digest(bearer.as_bytes()))
}

/// What presenting a secret did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Redeemed {
    /// The secret matched; its invite (this hash) is used up.
    Taken(String),
    Wrong,
    /// The fifth wrong secret: every open invite (these hashes) is gone.
    Burned(Vec<String>),
}

/// The invites open on this host, oldest first.
#[derive(Debug, Default, Clone)]
pub struct OpenInvites {
    entries: Vec<(String, String)>,
    failures: u32,
}

impl OpenInvites {
    /// From what was stored, oldest first.
    pub fn restore(mut stored: Vec<OpenInvite>) -> Self {
        stored.sort_by(|a, b| a.created_at.0.total_cmp(&b.created_at.0));
        Self { entries: stored.into_iter().map(|i| (i.hash, i.join_hash)).collect(), failures: 0 }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The relay bearer hashes of the open invites.
    pub fn join_hashes(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(_, join)| join.as_str())
    }

    /// Opens an invite for `secret`, making room first. Returns the stored
    /// form's two hashes and the hashes of the invites it pushed out.
    pub fn open(&mut self, secret: &str) -> ((String, String), Vec<String>) {
        let mut dropped = Vec::new();
        while self.entries.len() >= MAX_OPEN_INVITES {
            dropped.push(self.entries.remove(0).0);
        }
        let entry = (secret_hash(secret), bearer_hash(&relay_join_bearer(secret)));
        self.entries.push(entry.clone());
        self.failures = 0;
        (entry, dropped)
    }

    pub fn redeem(&mut self, secret: &str) -> Redeemed {
        let presented = Sha256::digest(secret.as_bytes());
        let hit = self
            .entries
            .iter()
            .position(|(hash, _)| hex::decode(hash).is_ok_and(|stored| same_bytes(&presented, &stored)));
        if let Some(at) = hit {
            return Redeemed::Taken(self.entries.remove(at).0);
        }
        self.failures += 1;
        if self.failures >= MAX_PAIR_FAILURES { Redeemed::Burned(self.cancel_all()) } else { Redeemed::Wrong }
    }

    /// Every open invite stops working; returns their hashes.
    pub fn cancel_all(&mut self) -> Vec<String> {
        self.entries.drain(..).map(|(hash, _)| hash).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_contracts::{Fingerprint, IntLit, PeerInviteRelay};

    fn invite() -> PeerInvite {
        PeerInvite {
            v: IntLit,
            fp: Fingerprint("ab".repeat(32)),
            sec: "s3cr3t-s3cr3t-s3cr3t-abc".into(),
            name: "Office iMac".into(),
            addrs: vec!["192.168.1.20:7402".into(), "[fd7a::1]:7402".into()],
            relay: None,
            exp: None,
        }
    }

    // `encodeInvite` over the same invite (manager/peer/invite-codec.ts).
    const TS_LINK: &str = "eos://pair/eyJ2IjoxLCJmcCI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIiLCJzZWMiOiJzM2NyM3QtczNjcjN0LXMzY3IzdC1hYmMiLCJuYW1lIjoiT2ZmaWNlIGlNYWMiLCJhZGRycyI6WyIxOTIuMTY4LjEuMjA6NzQwMiIsIltmZDdhOjoxXTo3NDAyIl19";

    #[test]
    fn a_link_reads_back_and_equals_the_typescript_encoding() {
        let link = encode_invite(&invite());
        assert_eq!(link, TS_LINK);
        assert_eq!(decode_invite(&format!("  {link}\n")), Ok(invite()));
        let with_relay = PeerInvite {
            relay: Some(PeerInviteRelay { url: "wss://relay.example/ws".into(), room: "r".repeat(43) }),
            ..invite()
        };
        assert_eq!(decode_invite(&encode_invite(&with_relay)), Ok(with_relay));
    }

    #[test]
    fn a_bad_link_says_what_is_wrong_with_it() {
        assert_eq!(decode_invite("https://example.com"), Err(InviteFormatError::NotAnInvite));
        // The recorded answer to this link (fixtures/wire/recordings/16-services.json).
        assert_eq!(decode_invite("eos://pair/not-a-real-invite-link"), Err(InviteFormatError::Damaged));
        assert_eq!(InviteFormatError::Damaged.to_string(), "invite link is damaged — copy it again");
        let v2 = format!("{PEER_INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(br#"{"v":2,"fp":"x"}"#));
        assert_eq!(decode_invite(&v2), Err(InviteFormatError::Incompatible));
    }

    #[test]
    fn only_links_that_carry_an_expiry_expire() {
        assert_eq!(invite_state(&invite(), i64::MAX), InviteState::Valid);
        let old = PeerInvite { exp: Some(1_700_000_000), ..invite() };
        assert_eq!(invite_state(&old, 1_699_999_999_999), InviteState::Valid);
        assert_eq!(invite_state(&old, 1_700_000_000_000), InviteState::Expired);
    }

    // Printed by `relayJoinBearer` / `bearerHash` (manager/peer/relay-pipe.ts) and sha256 hex.
    #[test]
    fn hashes_equal_the_typescript_ones() {
        let secret = "s3cr3t-s3cr3t-s3cr3t-abc";
        assert_eq!(secret_hash(secret), "8b7fee48f02996ee065d64fa85e38c8c650fa88473eb93583fd393683a1a73ec");
        assert_eq!(relay_join_bearer(secret), "tOVrjWqi_vnVW9Iae971fCvPhMkRDhhhhX65Q6bXgiA");
        assert_eq!(
            bearer_hash(&relay_join_bearer(secret)),
            "e14677e2e95bf73d9b8a0ede14acd6ef63922974dd417a5383dad498bfcfd88d"
        );
    }

    #[test]
    fn at_most_three_are_open_and_each_works_once() {
        let mut open = OpenInvites::default();
        let ((first, _), dropped) = open.open("secret-one-secret-one-11");
        assert!(dropped.is_empty());
        open.open("secret-two-secret-two-22");
        open.open("secret-three-secret-33-3");
        let (_, dropped) = open.open("secret-four-secret-four4");
        assert_eq!(dropped, [first], "the oldest makes room");
        assert_eq!(open.len(), MAX_OPEN_INVITES);

        assert_eq!(open.redeem("secret-one-secret-one-11"), Redeemed::Wrong, "pushed out");
        assert_eq!(open.redeem("secret-two-secret-two-22"), Redeemed::Taken(secret_hash("secret-two-secret-two-22")));
        assert_eq!(open.redeem("secret-two-secret-two-22"), Redeemed::Wrong, "used up");
        assert_eq!(open.len(), 2);
    }

    #[test]
    fn five_wrong_secrets_burn_every_open_invite() {
        let mut open = OpenInvites::default();
        open.open("secret-one-secret-one-11");
        open.open("secret-two-secret-two-22");
        for _ in 0..MAX_PAIR_FAILURES - 1 {
            assert_eq!(open.redeem("a-wrong-guess-a-wrong-gu"), Redeemed::Wrong);
        }
        let Redeemed::Burned(gone) = open.redeem("a-wrong-guess-a-wrong-gu") else { panic!("the fifth burns") };
        assert_eq!(gone.len(), 2);
        assert!(open.is_empty());
        assert_eq!(open.redeem("secret-one-secret-one-11"), Redeemed::Burned(vec![]), "nothing left to take");
        // A new invite starts the count again.
        open.open("secret-new-secret-new-12");
        assert_eq!(open.redeem("a-wrong-guess-a-wrong-gu"), Redeemed::Wrong);
    }

    #[test]
    fn stored_invites_come_back_oldest_first() {
        let stored = |hash: &str, at: f64| OpenInvite {
            hash: hash.repeat(64),
            join_hash: "0".repeat(64),
            created_at: at.into(),
        };
        let mut open = OpenInvites::restore(vec![stored("b", 2.0), stored("a", 1.0), stored("c", 3.0)]);
        let (_, dropped) = open.open("secret-new-secret-new-12");
        assert_eq!(dropped, ["a".repeat(64)]);
    }
}
