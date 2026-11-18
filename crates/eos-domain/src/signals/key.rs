//! Signal keys. A key names one thing a source saw, so the same thing seen
//! twice is one signal (`signals` is unique on source and key). Keys hold
//! paths, repositories and item ids: they are user data and never logged.

/// The longest key a signal may have, in characters. A source that makes a
/// longer one has made a bad key.
pub const KEY_MAX_CHARS: usize = 512;

/// Whether `key` may be stored: not empty and not too long.
pub fn fits(key: &str) -> bool {
    !key.is_empty() && key.chars().count() <= KEY_MAX_CHARS
}

/// A schedule's slot: `clock:<routine>:<slot_ms>`.
pub fn clock(routine: &str, slot_ms: i64) -> String {
    format!("clock:{routine}:{slot_ms}")
}

/// A run started by hand: `manual:<run id>`.
pub fn manual(run_id: &str) -> String {
    format!("manual:{run_id}")
}

/// A file as it stands: `file:<path>@<size>-<mtime_ms>`.
pub fn file(path: &str, size: u64, mtime_ms: i64) -> String {
    format!("file:{path}@{size}-{mtime_ms}")
}

/// A branch's head: `git:<repo>:<branch>@<sha>`.
pub fn git(repo: &str, branch: &str, sha: &str) -> String {
    format!("git:{repo}:{branch}@{sha}")
}

/// Another routine's finished run: `routine:<upstream>:run:<run id>`.
pub fn after(upstream: &str, run_id: &str) -> String {
    format!("routine:{upstream}:run:{run_id}")
}

/// A verified push from a service that has no list to poll:
/// `<service>:delivery:<delivery id>`.
pub fn delivery(service: &str, delivery_id: &str) -> String {
    format!("{service}:delivery:{delivery_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_key_has_its_shape() {
        assert_eq!(clock("rt-0a1b2c3d4e5f", 1_773_100_800_000), "clock:rt-0a1b2c3d4e5f:1773100800000");
        assert_eq!(manual("rn-0a1b2c3d4e5f"), "manual:rn-0a1b2c3d4e5f");
        assert_eq!(
            file("/Users/me/Inbox/a.pdf", 2048, 1_773_100_800_000),
            "file:/Users/me/Inbox/a.pdf@2048-1773100800000"
        );
        assert_eq!(git("/Users/me/game", "main", "9f1a4771"), "git:/Users/me/game:main@9f1a4771");
        assert_eq!(after("rt-0a1b2c3d4e5f", "rn-1b2c3d4e5f6a"), "routine:rt-0a1b2c3d4e5f:run:rn-1b2c3d4e5f6a");
        assert_eq!(delivery("github", "72d3162e"), "github:delivery:72d3162e");
    }

    #[test]
    fn a_key_fits_in_512_characters() {
        assert!(fits(&"k".repeat(512)));
        assert!(!fits(&"k".repeat(513)));
        assert!(fits(&"é".repeat(512)), "characters, not bytes");
        assert!(!fits(""));
        assert!(!fits(&file(&format!("/{}", "d".repeat(510)), 1, 1)), "a long path makes a bad key");
    }
}
