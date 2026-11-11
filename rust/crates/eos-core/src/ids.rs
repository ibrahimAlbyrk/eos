//! Every id the app mints, in the shape today's code gives it.
//!
//! Stored rows, the phone and the dashboard all hold ids of these shapes, and
//! the wire normalizer recognizes them by prefix and length, so a new id keeps
//! its shape. An implementation supplies only [`Ids::token`]; the shapes are
//! provided methods, so a test's deterministic generator yields them all.

use std::fmt::Write as _;

/// The characters a token is drawn from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alphabet {
    /// `0-9a-f`.
    Hex,
    /// `0-9a-z`.
    Base36,
    /// `A-Za-z0-9`.
    Base62,
}

impl Alphabet {
    pub fn chars(self) -> &'static [u8] {
        match self {
            Alphabet::Hex => b"0123456789abcdef",
            Alphabet::Base36 => b"0123456789abcdefghijklmnopqrstuvwxyz",
            Alphabet::Base62 => b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        }
    }
}

pub trait Ids: Send + Sync + 'static {
    /// `len` characters of `alphabet`, unpredictable in the real generator.
    fn token(&self, alphabet: Alphabet, len: usize) -> String;

    /// `prefix` followed by `len` characters of `alphabet`.
    fn prefixed(&self, prefix: &str, alphabet: Alphabet, len: usize) -> String {
        let mut id = String::with_capacity(prefix.len() + len);
        id.push_str(prefix);
        id.push_str(&self.token(alphabet, len));
        id
    }

    // `infra/src/id/RandomIdGenerator.ts`: a prefix and base36 characters.

    /// `w-` + 8.
    fn worker_id(&self) -> String {
        self.prefixed("w-", Alphabet::Base36, 8)
    }

    /// `o-` + 6.
    fn orchestrator_id(&self) -> String {
        self.prefixed("o-", Alphabet::Base36, 6)
    }

    /// `p-` + 8: a permission ask, a question, a tool use the app names itself.
    fn pending_id(&self) -> String {
        self.prefixed("p-", Alphabet::Base36, 8)
    }

    /// `r-` + 8: a request in the log, a peer request.
    fn request_id(&self) -> String {
        self.prefixed("r-", Alphabet::Base36, 8)
    }

    /// `l-` + 8.
    fn loop_id(&self) -> String {
        self.prefixed("l-", Alphabet::Base36, 8)
    }

    /// `s-` + 8: a conversation the app stores itself.
    fn session_id(&self) -> String {
        self.prefixed("s-", Alphabet::Base36, 8)
    }

    // Six random bytes in hex behind a prefix (`randomBytes(6).toString("hex")`).

    /// `pg-` + 12 (`manager/modules/pages`).
    fn page_id(&self) -> String {
        self.prefixed("pg-", Alphabet::Hex, 12)
    }

    /// `um-` + 12 (user memories).
    fn user_memory_id(&self) -> String {
        self.prefixed("um-", Alphabet::Hex, 12)
    }

    /// `dr-` + 12 (dream runs).
    fn dream_run_id(&self) -> String {
        self.prefixed("dr-", Alphabet::Hex, 12)
    }

    /// `tr-` + 12.
    fn transfer_id(&self) -> String {
        self.prefixed("tr-", Alphabet::Hex, 12)
    }

    /// `lg-` + 12 (a subscription sign-in).
    fn plan_login_id(&self) -> String {
        self.prefixed("lg-", Alphabet::Hex, 12)
    }

    /// `st-` + 12 (a plugin being installed).
    fn plugin_staging_id(&self) -> String {
        self.prefixed("st-", Alphabet::Hex, 12)
    }

    /// `bt-` + 12.
    fn browser_tab_id(&self) -> String {
        self.prefixed("bt-", Alphabet::Hex, 12)
    }

    /// 16 hex characters: one sign-in attempt (`manager/services/accounts`).
    fn sign_in_id(&self) -> String {
        self.token(Alphabet::Hex, 16)
    }

    /// 12 hex characters naming one run of the event stream.
    fn stream_epoch(&self) -> String {
        self.token(Alphabet::Hex, 12)
    }

    /// `v_` + 12 base62 characters: a visual answer (`contracts/src/genui/spec.ts`).
    fn view_id(&self) -> String {
        self.prefixed("v_", Alphabet::Base62, 12)
    }

    /// A version-4 UUID in its usual text form: projects, `!` command runs,
    /// terminal sessions.
    fn uuid(&self) -> String {
        let hex = self.token(Alphabet::Hex, 32);
        // The two fixed fields of a random UUID: version 4, variant 10xx.
        let variant = match hex.as_bytes().get(16) {
            Some(b'0' | b'4' | b'8' | b'c') => '8',
            Some(b'1' | b'5' | b'9' | b'd') => '9',
            Some(b'2' | b'6' | b'a' | b'e') => 'a',
            _ => 'b',
        };
        let part = |range: std::ops::Range<usize>| hex.get(range).unwrap_or_default();
        let mut id = String::with_capacity(36);
        let _ =
            write!(id, "{}-{}-4{}-{variant}{}-{}", part(0..8), part(8..12), part(13..16), part(17..20), part(20..32));
        id
    }

    /// 48 hex characters: the token that proves a request comes from this
    /// computer's dashboard.
    fn ui_token(&self) -> String {
        self.token(Alphabet::Hex, 48)
    }
}

/// Ids from the operating system's random source.
#[derive(Debug, Default, Clone, Copy)]
pub struct RandomIds;

impl Ids for RandomIds {
    fn token(&self, alphabet: Alphabet, len: usize) -> String {
        let chars = alphabet.chars();
        // Bytes at or above this would favour the first characters.
        let fair = 256 - 256 % chars.len();
        let mut out = String::with_capacity(len);
        let mut buf = [0u8; 64];
        while out.len() < len {
            // The system's random source failing is not something an id can
            // recover from; it does not fail on the systems Eos runs on.
            if let Err(e) = getrandom::fill(&mut buf) {
                panic!("the system's random source failed: {e}");
            }
            for byte in buf.iter().map(|b| usize::from(*b)).filter(|b| *b < fair) {
                if out.len() < len {
                    out.push(char::from(chars[byte % chars.len()]));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_of(s: &str, alphabet: Alphabet) -> bool {
        s.bytes().all(|b| alphabet.chars().contains(&b))
    }

    fn shaped(id: &str, prefix: &str, alphabet: Alphabet, len: usize) -> bool {
        id.strip_prefix(prefix).is_some_and(|rest| rest.len() == len && all_of(rest, alphabet))
    }

    #[test]
    fn ids_have_todays_shapes() {
        let ids = RandomIds;
        assert!(shaped(&ids.worker_id(), "w-", Alphabet::Base36, 8));
        assert!(shaped(&ids.orchestrator_id(), "o-", Alphabet::Base36, 6));
        assert!(shaped(&ids.pending_id(), "p-", Alphabet::Base36, 8));
        assert!(shaped(&ids.request_id(), "r-", Alphabet::Base36, 8));
        assert!(shaped(&ids.loop_id(), "l-", Alphabet::Base36, 8));
        assert!(shaped(&ids.session_id(), "s-", Alphabet::Base36, 8));
        for (id, prefix) in [
            (ids.page_id(), "pg-"),
            (ids.user_memory_id(), "um-"),
            (ids.dream_run_id(), "dr-"),
            (ids.transfer_id(), "tr-"),
            (ids.plan_login_id(), "lg-"),
            (ids.plugin_staging_id(), "st-"),
            (ids.browser_tab_id(), "bt-"),
        ] {
            assert!(shaped(&id, prefix, Alphabet::Hex, 12), "{id}");
        }
        assert!(shaped(&ids.view_id(), "v_", Alphabet::Base62, 12));
        assert!(shaped(&ids.stream_epoch(), "", Alphabet::Hex, 12));
        assert!(shaped(&ids.sign_in_id(), "", Alphabet::Hex, 16));
        assert!(shaped(&ids.ui_token(), "", Alphabet::Hex, 48));
    }

    #[test]
    fn a_uuid_is_version_4() {
        let id = RandomIds.uuid();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12], "{id}");
        assert!(parts[2].starts_with('4'), "{id}");
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'), "{id}");
        assert!(all_of(&id.replace('-', ""), Alphabet::Hex));
    }

    #[test]
    fn tokens_do_not_repeat_and_use_the_whole_alphabet() {
        let ids = RandomIds;
        assert_ne!(ids.worker_id(), ids.worker_id());
        let long = ids.token(Alphabet::Base62, 4000);
        assert_eq!(long.len(), 4000);
        for c in Alphabet::Base62.chars() {
            assert!(long.as_bytes().contains(c), "{} never drawn", char::from(*c));
        }
    }
}
