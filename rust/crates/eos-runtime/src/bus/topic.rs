//! Topics: a name, the payload type published under it, and — for the few
//! high-volume ones — what each event is about.

use std::borrow::Borrow;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// A topic's name: a constant for declared topics, shared text for the
/// `plugin:<id>:<event>` family.
#[derive(Clone)]
pub enum TopicName {
    Static(&'static str),
    Shared(Arc<str>),
}

impl TopicName {
    pub fn as_str(&self) -> &str {
        match self {
            TopicName::Static(s) => s,
            TopicName::Shared(s) => s,
        }
    }
}

impl PartialEq for TopicName {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}
impl Eq for TopicName {}
impl Hash for TopicName {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_str().hash(state);
    }
}
impl Borrow<str> for TopicName {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}
impl fmt::Debug for TopicName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}
impl fmt::Display for TopicName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl From<&'static str> for TopicName {
    fn from(s: &'static str) -> Self {
        TopicName::Static(s)
    }
}
impl From<String> for TopicName {
    fn from(s: String) -> Self {
        TopicName::Shared(s.into())
    }
}
impl From<Arc<str>> for TopicName {
    fn from(s: Arc<str>) -> Self {
        TopicName::Shared(s)
    }
}

/// What a scoped topic's events are about. A dashboard tab that said what it
/// has on screen gets such events only for those workers / terminals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScopeKind {
    /// The payload's `workerId` (`agent:delta`, `genui:delta`, `workflow:progress`).
    Worker,
    /// The payload's `sessionId` (`pty:data`).
    Pty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub kind: ScopeKind,
    pub id: Arc<str>,
}

impl Scope {
    pub fn worker(id: impl Into<Arc<str>>) -> Self {
        Self { kind: ScopeKind::Worker, id: id.into() }
    }

    pub fn pty(id: impl Into<Arc<str>>) -> Self {
        Self { kind: ScopeKind::Pty, id: id.into() }
    }
}

/// A topic and its payload type. Declared once as a constant; publishing
/// under it only compiles with that payload.
///
/// ```
/// use eos_runtime::bus::{ScopeKind, Topic};
///
/// #[derive(serde::Serialize)]
/// struct PageChange { id: String }
/// #[derive(serde::Serialize)]
/// struct Delta { worker_id: String, text: String }
///
/// const PAGES_CHANGE: Topic<PageChange> = Topic::new("pages:change");
/// const AGENT_DELTA: Topic<Delta> =
///     Topic::scoped("agent:delta", ScopeKind::Worker, |d| Some(d.worker_id.as_str()));
/// # let _ = (PAGES_CHANGE, AGENT_DELTA);
/// ```
pub struct Topic<T> {
    name: &'static str,
    scope: Option<(ScopeKind, ScopeOf<T>)>,
}

/// Reads from a payload which worker or terminal it is about.
type ScopeOf<T> = fn(&T) -> Option<&str>;

impl<T> Topic<T> {
    pub const fn new(name: &'static str) -> Self {
        Self { name, scope: None }
    }

    /// A topic whose events are each about one worker or terminal; `of` reads
    /// which one from the payload (`None`: the event goes to every stream).
    pub const fn scoped(name: &'static str, kind: ScopeKind, of: ScopeOf<T>) -> Self {
        Self { name, scope: Some((kind, of)) }
    }

    pub const fn name(&self) -> &'static str {
        self.name
    }

    /// What a module lists so that two features cannot claim one topic.
    pub fn decl(&self) -> TopicDecl {
        TopicDecl { name: self.name, scope: self.scope.map(|(kind, _)| kind) }
    }

    pub(crate) fn scope_of(&self, payload: &T) -> Option<Scope> {
        let (kind, of) = self.scope?;
        of(payload).map(|id| Scope { kind, id: id.into() })
    }
}

impl<T> Clone for Topic<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for Topic<T> {}
impl<T> fmt::Debug for Topic<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Topic").field("name", &self.name).finish_non_exhaustive()
    }
}

/// A topic as a module declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopicDecl {
    pub name: &'static str,
    pub scope: Option<ScopeKind>,
}

/// Which topics a subscriber hears.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    /// Every topic (today's `"*"`).
    All,
    Topic(TopicName),
}

impl From<&'static str> for Filter {
    fn from(name: &'static str) -> Self {
        Filter::Topic(name.into())
    }
}
impl From<TopicName> for Filter {
    fn from(name: TopicName) -> Self {
        Filter::Topic(name)
    }
}
impl<T> From<&Topic<T>> for Filter {
    fn from(topic: &Topic<T>) -> Self {
        Filter::Topic(topic.name.into())
    }
}
