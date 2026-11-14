//! A chat from before the engine continues from the conversation Claude Code
//! recorded for it. The TypeScript app resumes that same chat by the same
//! Claude Code session, so a user who went back to it can go on there; the
//! engine notes what it took (`<worker>.origin.json` beside its own record)
//! and takes the conversation again when Claude Code's has gone on since.

use std::path::{Path, PathBuf};

use eos_agent_compat::ClaudeSession;
use serde::{Deserialize, Serialize};

/// What the engine's record of a chat was taken from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Origin {
    /// The Claude Code session.
    pub(crate) session_id: String,
    /// Its transcript's length, and the messages read from it, when taken.
    pub(crate) bytes: u64,
    pub(crate) messages: usize,
}

/// A Claude Code transcript as it is now.
pub(crate) struct Recorded {
    pub(crate) bytes: u64,
    pub(crate) session: ClaudeSession,
}

/// The transcript at `path` with its conversation; `None` when there is none.
pub(crate) fn recorded(path: &Path) -> Option<Recorded> {
    let bytes = std::fs::metadata(path).ok()?.len();
    let session = ClaudeSession::read(path).ok()?;
    (!session.messages.is_empty()).then_some(Recorded { bytes, session })
}

impl Origin {
    pub(crate) fn of(session_id: &str, recorded: &Recorded) -> Self {
        Self { session_id: session_id.to_owned(), bytes: recorded.bytes, messages: recorded.session.messages.len() }
    }

    /// Whether Claude Code's conversation for the chat went on after it was
    /// taken: the chat is now resumed by another session, or its transcript
    /// holds more (or fewer) messages. Lines Claude Code adds without a turn
    /// do not count, and a transcript Claude Code has since deleted has not
    /// gone on.
    pub(crate) fn gone_on(&self, session_id: &str, transcript: Option<&Path>) -> bool {
        if self.session_id != session_id {
            return true;
        }
        let Some(path) = transcript else { return false };
        match std::fs::metadata(path) {
            Ok(meta) if meta.len() != self.bytes => {
                ClaudeSession::read(path).is_ok_and(|now| now.messages.len() != self.messages)
            }
            _ => false,
        }
    }
}

/// Where the note for the record at `record` is kept.
pub(crate) fn note_path(record: &Path) -> PathBuf {
    record.with_extension("origin.json")
}

/// The note, if there is one that reads.
pub(crate) async fn read(record: &Path) -> Option<Origin> {
    let bytes = tokio::fs::read(note_path(record)).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) async fn write(record: &Path, origin: &Origin) {
    let path = note_path(record);
    let written = match serde_json::to_vec(origin) {
        Ok(bytes) => tokio::fs::write(&path, bytes).await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    // Without the note the record is still used; the next resume notes it again.
    if let Err(error) = written {
        tracing::warn!(path = %path.display(), %error, "where a conversation was taken from could not be noted");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(uuid: &str, parent: Option<&str>, role: &str, text: &str) -> String {
        serde_json::json!({
            "type": role, "uuid": uuid, "parentUuid": parent, "sessionId": "s",
            "timestamp": "2026-01-01T00:00:00.000Z", "message": {"role": role, "content": text},
        })
        .to_string()
            + "\n"
    }

    #[test]
    fn only_more_turns_or_another_session_count_as_going_on() {
        let dir = tempfile::tempdir().expect("a folder");
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, line("u1", None, "user", "hi") + &line("a1", Some("u1"), "assistant", "hello"))
            .expect("writes");
        let taken = Origin::of("s", &recorded(&path).expect("a conversation"));
        assert_eq!(taken.messages, 2);
        assert!(!taken.gone_on("s", Some(&path)));
        assert!(taken.gone_on("other", Some(&path)), "resumed by another session now");

        let mut more = std::fs::read_to_string(&path).expect("reads");
        more.push_str(r#"{"type":"summary","summary":"a title","leafUuid":"a1"}"#);
        more.push('\n');
        std::fs::write(&path, &more).expect("writes");
        assert!(!taken.gone_on("s", Some(&path)), "a line without a turn");

        more.push_str(&line("u2", Some("a1"), "user", "and now?"));
        more.push_str(&line("a2", Some("u2"), "assistant", "this"));
        std::fs::write(&path, &more).expect("writes");
        assert!(taken.gone_on("s", Some(&path)));

        std::fs::remove_file(&path).expect("deletes");
        assert!(!taken.gone_on("s", Some(&path)), "Claude Code deleted an old transcript");
    }
}
