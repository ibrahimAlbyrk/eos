//! What routines ask of surfaces: the designed view, page or app a routine
//! makes follows the routine through its life (05 §4).

use crate::{BoxFuture, Error};

/// The surface of a routine whose blueprint makes a view, a page or an app.
/// Each call comes after the routine's own write committed; a failure here
/// never undoes it.
pub trait SurfaceAuthoring: Send + Sync {
    /// A routine was created: its surface starts from `version_id`'s
    /// blueprint, which makes `makes`.
    fn create_for_routine<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
        makes: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine started: the surface's candidate becomes its first kept
    /// version.
    fn keep<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine was archived or deleted.
    fn archive_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine came back from the archive or from Recently deleted.
    fn restore_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}

/// Runs a surface's direct action the way a press of its button does: the
/// dispatcher resolves the arguments from the stored issue, passes the gate
/// and keeps the record. For Needs you's cards and the phone.
pub trait DirectActions: Send + Sync {
    /// `origin`: `dashboard`, `phone`, `mail_link` or `app`.
    fn run<'a>(
        &'a self,
        request: eos_contracts::ActionRunRequest,
        origin: &'a str,
    ) -> BoxFuture<'a, Result<eos_contracts::ActionAnswer, Error>>;
}

/// What a run hands back with `return_view`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReturnedView {
    /// `result` or `question`.
    pub place: String,
    /// The View as `present` takes it.
    pub view: serde_json::Value,
    /// `{viewActionId: {action, args}}`: what each `send` runs.
    pub bindings: Option<serde_json::Value>,
}

/// The surface tools of a run's sessions.
pub trait SurfaceTools: Send + Sync {
    /// Stores the View as an issue of the caller's routine's View surface and
    /// answers the line the agent reads; every problem is a validation error
    /// listing them all.
    fn return_view<'a>(&'a self, worker_id: &'a str, view: ReturnedView) -> BoxFuture<'a, Result<String, Error>>;
}

/// A returned View as Needs you shows it (03 §4.5): a `question` View is a
/// question its run waits on; a `result` View a card the user can put aside.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewCard {
    pub routine_id: String,
    pub run_id: String,
    pub surface_id: String,
    pub issue_id: String,
    pub question: bool,
    pub title: String,
    pub summary: String,
    /// The user started the run by hand.
    pub by_hand: bool,
}

/// Needs you's items for returned Views, handed to the surfaces at composition.
pub trait ViewCards: Send + Sync {
    /// Opens the View's item inside the job that stores its issue; its id.
    fn open_in(
        &self,
        tx: &dyn crate::store::Tx,
        out: &mut crate::store::Outbox,
        now: i64,
        card: &ViewCard,
    ) -> Result<String, Error>;
    /// Waits, without a limit, for the answer to a question View's item:
    /// what the user pressed, as its run reads it. Its item is taken back
    /// when the waiter stops waiting.
    fn heard<'a>(&'a self, item_id: &'a str) -> BoxFuture<'a, String>;
    /// Answers a question View's item with what the user pressed.
    fn answer<'a>(&'a self, item_id: &'a str, pressed: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}
