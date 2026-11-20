//! What a note is: its kind, how far it is trusted, where it applies, its
//! state and the hooks that bring it back.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Names stored in the database and written on the wire, one per value.
macro_rules! named {
    ($ty:ident { $($variant:ident => $name:literal),+ $(,)? }) => {
        impl $ty {
            pub const ALL: &'static [$ty] = &[$($ty::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $($ty::$variant => $name),+ }
            }

            pub fn parse(name: &str) -> Option<Self> {
                match name { $($name => Some($ty::$variant),)+ _ => None }
            }
        }
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Episode,
    Lesson,
    Fact,
    Skill,
    Example,
    Playbook,
}
named!(NoteKind { Episode => "episode", Lesson => "lesson", Fact => "fact", Skill => "skill", Example => "example", Playbook => "playbook" });

/// Where a note's knowledge came from, which bounds how strong it may get.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    /// The user said it.
    Said,
    /// The user did it (an edit, a stop, an undo).
    Did,
    /// The work's outcome showed it (a failure, a checker's verdict).
    Outcome,
    /// Inferred without the user: from outside text or a pattern.
    Guess,
}
named!(Trust { Said => "said", Did => "did", Outcome => "outcome", Guess => "guess" });

impl Trust {
    /// The highest strength a note of this trust reaches.
    pub fn cap(self) -> f64 {
        match self {
            Trust::Said => 1.0,
            Trust::Did => 0.9,
            Trust::Outcome => 0.8,
            Trust::Guess => 0.6,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteState {
    Trying,
    Firm,
    Cooling,
    Closed,
}
named!(NoteState { Trying => "trying", Firm => "firm", Cooling => "cooling", Closed => "closed" });

/// How wide a note applies, narrowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeLevel {
    /// One routine; the key is its id.
    Routine,
    /// One project; the key is its project key.
    Project,
    /// One kind of work; the key is a work kind (the About-you memory domains).
    Work,
    /// Everywhere; the key is empty.
    Everywhere,
}
named!(ScopeLevel { Routine => "routine", Project => "project", Work => "work", Everywhere => "everywhere" });

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Scope {
    pub level: ScopeLevel,
    pub key: String,
}

impl Scope {
    pub fn everywhere() -> Self {
        Self { level: ScopeLevel::Everywhere, key: String::new() }
    }

    /// Ranking weight: a narrower scope fits its situation better.
    pub fn factor(&self) -> f64 {
        match self.level {
            ScopeLevel::Routine => 1.0,
            ScopeLevel::Project => 0.9,
            ScopeLevel::Work => 0.8,
            ScopeLevel::Everywhere => 0.7,
        }
    }

    /// One level wider, for a lesson learned the same way under a second key:
    /// a routine's to its project, a project's to its kind of work, a kind of
    /// work's to everywhere. `None` when the wider key is unknown.
    pub fn widen(&self, project: Option<&str>, work_kind: Option<&str>) -> Option<Scope> {
        let (level, key) = match self.level {
            ScopeLevel::Routine => (ScopeLevel::Project, project?.to_owned()),
            ScopeLevel::Project => (ScopeLevel::Work, work_kind?.to_owned()),
            ScopeLevel::Work => (ScopeLevel::Everywhere, String::new()),
            ScopeLevel::Everywhere => return None,
        };
        Some(Scope { level, key })
    }
}

/// One line of a routine's playbook and the notes it came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaybookLine {
    pub text: String,
    #[serde(default)]
    pub from: Vec<String>,
}

/// The structured part of a note, by kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NoteBody {
    Lesson {
        situation: String,
        wrong: String,
        instead: String,
    },
    Skill {
        situation: String,
        steps: Vec<String>,
    },
    Example {
        #[serde(rename = "runId")]
        run_id: String,
        excerpt: String,
    },
    Playbook {
        lines: Vec<PlaybookLine>,
    },
    None {},
}

#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    /// `mn-…`.
    pub id: String,
    pub kind: NoteKind,
    /// One or two sentences, at most 300 characters, as the model reads it.
    pub text: String,
    pub body: NoteBody,
    pub trust: Trust,
    pub state: NoteState,
    pub scope: Scope,
    pub valid_from: i64,
    pub valid_to: Option<i64>,
    pub replaced_by: Option<String>,
    /// Hook ids the note says to touch, and to stay away from.
    pub do_hooks: Vec<String>,
    pub avoid_hooks: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The device that wrote the newest change.
    pub device: String,
}

impl Note {
    /// Live at `now`: not closed, not replaced, inside its validity.
    pub fn live(&self, now: i64) -> bool {
        self.state != NoteState::Closed
            && self.replaced_by.is_none()
            && self.valid_from <= now
            && self.valid_to.is_none_or(|to| now < to)
    }
}

/// What a hook names: the things a situation and a note share.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookKind {
    Person,
    Project,
    Path,
    Tool,
    Command,
    Library,
    Task,
    Error,
    Topic,
    Machine,
    Routine,
}
named!(HookKind {
    Person => "person", Project => "project", Path => "path", Tool => "tool", Command => "command",
    Library => "library", Task => "task", Error => "error", Topic => "topic", Machine => "machine",
    Routine => "routine",
});

/// A hook's id: `mh-` and the first 16 hex digits of SHA-256(`kind:key`), the
/// same on every Mac so synced notes meet the same hooks.
pub fn hook_id(kind: HookKind, key: &str) -> String {
    let digest = Sha256::digest(format!("{}:{key}", kind.as_str()).as_bytes());
    format!("mh-{}", &hex::encode(digest)[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_reads_back() {
        for kind in NoteKind::ALL {
            assert_eq!(NoteKind::parse(kind.as_str()), Some(*kind));
        }
        for trust in Trust::ALL {
            assert_eq!(Trust::parse(trust.as_str()), Some(*trust));
        }
        for state in NoteState::ALL {
            assert_eq!(NoteState::parse(state.as_str()), Some(*state));
        }
        for level in ScopeLevel::ALL {
            assert_eq!(ScopeLevel::parse(level.as_str()), Some(*level));
        }
        for kind in HookKind::ALL {
            assert_eq!(HookKind::parse(kind.as_str()), Some(*kind));
        }
        assert_eq!(NoteKind::parse("Lesson"), None);
    }

    #[test]
    fn a_hook_id_is_the_same_everywhere_and_differs_by_kind() {
        let id = hook_id(HookKind::Command, "npm run lint");
        assert_eq!(id, hook_id(HookKind::Command, "npm run lint"));
        assert_eq!(id.len(), 19);
        assert!(id.starts_with("mh-"));
        assert_ne!(id, hook_id(HookKind::Tool, "npm run lint"));
    }

    #[test]
    fn a_scope_widens_one_level_at_a_time() {
        let routine = Scope { level: ScopeLevel::Routine, key: "r-1".into() };
        let project = routine.widen(Some("p"), Some("code")).unwrap();
        assert_eq!(project, Scope { level: ScopeLevel::Project, key: "p".into() });
        let work = project.widen(None, Some("code")).unwrap();
        assert_eq!(work.level, ScopeLevel::Work);
        assert_eq!(work.widen(None, None), Some(Scope::everywhere()));
        assert_eq!(Scope::everywhere().widen(Some("p"), Some("code")), None);
        assert_eq!(routine.widen(None, Some("code")), None, "no project known");
        assert!(ScopeLevel::Routine < ScopeLevel::Everywhere, "narrowest first");
    }

    #[test]
    fn a_body_reads_back_by_its_fields() {
        let lesson = NoteBody::Lesson { situation: "s".into(), wrong: "w".into(), instead: "i".into() };
        let json = serde_json::to_value(&lesson).unwrap();
        assert_eq!(serde_json::from_value::<NoteBody>(json).unwrap(), lesson);
        let example = NoteBody::Example { run_id: "run-1".into(), excerpt: "e".into() };
        let json = serde_json::to_value(&example).unwrap();
        assert_eq!(json, serde_json::json!({"runId": "run-1", "excerpt": "e"}));
        assert_eq!(serde_json::from_value::<NoteBody>(json).unwrap(), example);
        assert_eq!(serde_json::from_str::<NoteBody>("{}").unwrap(), NoteBody::None {});
    }

    #[test]
    fn a_closed_replaced_or_expired_note_is_not_live() {
        let note = Note {
            id: "mn-1".into(),
            kind: NoteKind::Lesson,
            text: "t".into(),
            body: NoteBody::None {},
            trust: Trust::Did,
            state: NoteState::Trying,
            scope: Scope::everywhere(),
            valid_from: 10,
            valid_to: Some(100),
            replaced_by: None,
            do_hooks: vec![],
            avoid_hooks: vec![],
            created_at: 10,
            updated_at: 10,
            device: "d".into(),
        };
        assert!(note.live(50));
        assert!(!note.live(5));
        assert!(!note.live(100));
        assert!(!Note { state: NoteState::Closed, ..note.clone() }.live(50));
        assert!(!Note { replaced_by: Some("mn-2".into()), ..note }.live(50));
    }
}
