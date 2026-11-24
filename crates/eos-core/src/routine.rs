//! What routines offer the other areas: starting and stopping runs, which
//! run a worker belongs to, and control over a routine's Freedom and state
//! for the areas that hold or pause it.

use std::path::PathBuf;

use eos_contracts::{
    BlueprintIssue, CheckVerdict, Freedom, ItemRef, Recipient, RecipientKind, RecipientsUnconfirmed, ResultDoc,
    RoutineKind, RoutineState, RunInput, Rung, UnconfirmedRecipient, When, Which,
};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState};
use eos_domain::run_scope::{RunRole, Trust};

use crate::store::{Outbox, Tx};
use crate::{BoxFuture, Error, Ids};

/// Who asked for a run. Each origin is checked in one place, the start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOrigin {
    /// The user, through a door of Eos.
    Hand,
    /// The user, doing an earlier run again.
    Again { run_id: String },
    /// A trial of a routine being made.
    Trial,
    /// An agent in a chat; only when the routine lets agents start it.
    Agent { worker_id: String },
    /// Another routine's run; only when this routine's When names it.
    Routine { run_id: String },
    /// Memory's check of a playbook candidate on a past run's item (01 G50):
    /// a trial that shows its result, sends nothing and earns no credit.
    Replay { candidate: String },
    /// One of the routine's surfaces (01 G51): a design, an App build or an
    /// ask, as the run's input says.
    Surface { surface_id: String },
}

impl RunOrigin {
    /// The word `runs.origin` stores.
    pub fn word(&self) -> &'static str {
        match self {
            RunOrigin::Hand => "hand",
            RunOrigin::Again { .. } => "again",
            RunOrigin::Trial => "trial",
            RunOrigin::Agent { .. } => "agent",
            RunOrigin::Routine { .. } => "routine",
            RunOrigin::Replay { .. } => "replay",
            RunOrigin::Surface { .. } => "surface",
        }
    }

    /// What `runs.origin_ref` names: the earlier run, the worker, the run
    /// upstream, the playbook candidate.
    pub fn reference(&self) -> Option<&str> {
        match self {
            RunOrigin::Hand | RunOrigin::Trial => None,
            RunOrigin::Again { run_id } | RunOrigin::Routine { run_id } => Some(run_id),
            RunOrigin::Agent { worker_id } => Some(worker_id),
            RunOrigin::Replay { candidate } => Some(candidate),
            RunOrigin::Surface { surface_id } => Some(surface_id),
        }
    }
}

/// One start: one run, or one run per item of `items`.
#[derive(Debug, Clone, PartialEq)]
pub struct NewRun {
    pub routine_id: String,
    /// The version to run: a trial runs the draft it was started for. `None`
    /// runs the version the routine runs from when the run leaves the queue.
    pub version: Option<String>,
    pub input: RunInput,
    /// Several items, one run each; empty for one run of `input`.
    pub items: Vec<ItemRef>,
    pub origin: RunOrigin,
    /// Where the user started it.
    pub door: Option<String>,
    /// Start although the routine handled the same item lately.
    pub confirm_repeat: bool,
    /// The same id again, within ten minutes, answers the same runs.
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunCreated {
    pub id: String,
    pub state: RunState,
    pub not_before: Option<i64>,
}

/// Why a start was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// 404.
    UnknownRoutine(String),
    /// 409: the routine handled the item within a day, or handles it now.
    SameItem {
        existing_run_id: String,
    },
    /// 409: the routine's state does not take this start.
    RoutineState(RoutineState),
    /// 409: the version it would run was made by a newer Eos.
    NewerFormat,
    /// 400; the text names the field.
    Invalid(String),
    /// 409: everything routines may spend today is spent; the user may
    /// raise today's cap.
    DayCap,
    /// 409: the user stopped everything on this Mac (03 G10).
    Halted,
    /// 409: something the runs need is not set up here; nothing was queued.
    Unready(Unready),
    Store(Error),
}

/// What a run needs that is not set up on this computer, found before any
/// run is queued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unready {
    /// No project here is a clone of the repository the run works in; its
    /// remote (`github.com/acme/game`) when it is known.
    NoLocalClone { repo: Option<String> },
    /// The capability does not take calls until the user signs in.
    SignIn { capability: String },
    /// The capability is not on this computer, or does not take calls.
    Capability { capability: String },
}

impl Unready {
    /// The stable code a refusal carries.
    pub fn code(&self) -> &'static str {
        match self {
            Unready::NoLocalClone { .. } => "no_local_clone",
            Unready::SignIn { .. } => "needs_sign_in",
            Unready::Capability { .. } => "capability_not_ready",
        }
    }

    /// What is missing and how the user supplies it.
    pub fn message(&self) -> String {
        match self {
            Unready::NoLocalClone { repo: Some(repo) } => {
                format!("{repo} is not a project in Eos. Add your local clone of it as a project, then start again.")
            }
            Unready::NoLocalClone { repo: None } => "This routine works in a repository that is not a project in \
                 Eos. Add your local clone of it as a project, then start again."
                .to_owned(),
            Unready::SignIn { capability } => {
                format!("{capability} is not signed in. Sign in to it in Capabilities, then start again.")
            }
            Unready::Capability { capability } => {
                format!("{capability} is not ready on this computer. Set it up in Capabilities, then start again.")
            }
        }
    }
}

impl From<Error> for StartError {
    fn from(error: Error) -> Self {
        StartError::Store(error)
    }
}

/// Why a routine paused because a target was refused does not resume yet:
/// the head's Goes to names recipients the user has not confirmed (D53).
#[derive(Debug, Clone, PartialEq)]
pub struct ResumeRefusal {
    pub recipients: Vec<Recipient>,
}

impl ResumeRefusal {
    /// The 409 body every route that resumes answers.
    pub fn answer(&self) -> RecipientsUnconfirmed {
        let recipients = self
            .recipients
            .iter()
            .map(|recipient| UnconfirmedRecipient { id: recipient.id.clone(), label: label(recipient) });
        RecipientsUnconfirmed {
            error: "Confirm where this routine sends before it resumes.".to_owned(),
            code: "recipients_unconfirmed".to_owned(),
            recipients: recipients.collect(),
        }
    }
}

/// A recipient as the user reads it: the address (a GitHub login with its
/// `@`), "you", or where the item came from.
fn label(recipient: &Recipient) -> String {
    match &recipient.kind {
        RecipientKind::Me { .. } => "you".to_owned(),
        RecipientKind::Fixed { channel, address, .. } if channel == "github" && !address.starts_with('@') => {
            format!("@{address}")
        }
        RecipientKind::Fixed { address, .. } => address.clone(),
        RecipientKind::ItemPlace { channel, .. } if channel == "github" => "the pull request".to_owned(),
        RecipientKind::ItemPlace { .. } => "the item's sender".to_owned(),
    }
}

/// Why a resume did not happen.
#[derive(Debug, Clone, PartialEq)]
pub enum ResumeError {
    /// 409: recipients to confirm first.
    Unconfirmed(ResumeRefusal),
    Store(Error),
}

impl From<Error> for ResumeError {
    fn from(error: Error) -> Self {
        ResumeError::Store(error)
    }
}

/// Starts and stops runs: every door, the tools and the gateways start
/// through it.
pub trait RunStarter: Send + Sync {
    /// Checks the start and queues its runs in one write; the supervisor
    /// starts them when it may.
    fn start(&self, run: NewRun) -> BoxFuture<'_, Result<Vec<RunCreated>, StartError>>;
    /// Cancels a run that has not ended. A run that is delivering cannot be
    /// stopped (409).
    fn stop<'a>(&'a self, run_id: &'a str, why: Reason) -> BoxFuture<'a, Result<(), Error>>;
}

/// Replays of past runs for memory's playbook check (01 G50, 04 G12c).
pub trait RunReplays: Send + Sync {
    /// Runs each of `run_ids`' items again, on the routine's head, shown
    /// only, with playbook candidate `candidate`; answers the new runs' ids.
    /// A past run with no item is left out.
    fn replay<'a>(
        &'a self,
        routine_id: &'a str,
        candidate: &'a str,
        run_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, StartError>>;
}

/// The run a worker works for, and its place in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRef {
    pub run_id: String,
    pub routine_id: String,
    /// The routine's version the run runs from.
    pub version_id: String,
    /// `standing`, `project`, `once`, `trial`, `design`, `app-build` or
    /// `ask`.
    pub kind: String,
    pub role: RunRole,
    /// The agent of the routine's Who it is.
    pub agent_key: Option<String>,
    pub trust: Trust,
    /// What started the run: `hand`, `trigger`, `routine`, `agent`, `again`,
    /// `trial`, `replay` or `surface`.
    pub origin: String,
    pub started_at: i64,
    /// Where the run keeps what it made, under Eos's data folder
    /// (`routines/<routine>/runs/<run>`).
    pub output_dir: PathBuf,
}

/// Which run a worker belongs to. Inside a write job the same read is
/// `tx.routine_sessions().run_of(worker_id)`.
pub trait RunLookup: Send + Sync {
    /// `None` for a worker of no run: a chat, a routine's architect.
    fn run_of<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<RunRef>>;
}

/// A run a signal starts, as the signals' router admits it inside its own
/// write job.
#[derive(Debug, Clone, PartialEq)]
pub struct Admission {
    pub routine_id: String,
    /// The signal's row id: one signal starts at most one run of a routine.
    pub signal_id: i64,
    pub input: RunInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmitOutcome {
    Queued { run_id: String },
    Refused { reason: AdmitRefusal },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmitRefusal {
    /// The queue holds as many runs as it may.
    QueueFull,
    /// The routine is gone or does not take triggered runs now.
    NotActive,
}

/// A routine's runs as the signals' limits count them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutineLoad {
    /// Waiting in the queue.
    pub queued: i64,
    /// Made at or after the time asked about.
    pub started_since: i64,
    /// Out of the queue and not ended.
    pub active: i64,
}

/// A run that ended, in the order runs ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedRun {
    /// The `run_events` id of its last state change: later runs end higher.
    pub seq: i64,
    pub run_id: String,
    pub state: RunState,
    pub reason: Option<Reason>,
    pub outcome: Option<Outcome>,
    pub ended_at: i64,
}

/// Runs the signals' router starts and counts, inside its own write job, so a
/// signal's decision and its run are saved together.
pub trait RunIntake: Send + Sync {
    fn admit(&self, tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error>;
    /// Skips a queued run a newer signal of the same subject replaces; false
    /// when it has left the queue.
    fn supersede(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<bool, Error>;
    fn load(&self, tx: &dyn Tx, routine_id: &str, since: i64) -> Result<RoutineLoad, Error>;
    /// The routine's runs that ended after the one whose end is `after_seq`,
    /// first ended first, at most `limit`.
    fn finished_after(
        &self,
        tx: &dyn Tx,
        routine_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<FinishedRun>, Error>;
}

/// What starts a routine's runs, from its head version.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutineTriggers {
    pub id: String,
    /// The head version's id.
    pub version: String,
    pub state: RoutineState,
    pub kind: RoutineKind,
    pub when: When,
    pub which: Which,
}

pub trait RoutineDirectory: Send + Sync {
    /// Every routine with a head this app runs, deleted ones left out.
    fn triggers(&self) -> BoxFuture<'_, Result<Vec<RoutineTriggers>, Error>>;
}

/// What the user confirmed of a routine: the Freedom and Goes to of its
/// latest version the user wrote or confirmed.
#[derive(Debug, Clone, PartialEq)]
pub struct Confirmed {
    pub freedom: Freedom,
    pub goes_to: Vec<Recipient>,
}

/// Changes to a routine that another area makes. Each change of Freedom is
/// a new version of its blueprint.
pub trait RoutineControl: Send + Sync {
    fn confirmed<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<Confirmed, Error>>;
    /// [`confirmed`](RoutineControl::confirmed) inside the caller's job.
    fn confirmed_in(&self, tx: &dyn Tx, routine_id: &str) -> Result<Confirmed, Error>;
    /// Gives the routine more freedom, in a version the user authored (an
    /// offer accepted).
    fn raise<'a>(&'a self, routine_id: &'a str, rung: Rung) -> BoxFuture<'a, Result<(), Error>>;
    /// Holds its results as drafts again, in a version Eos authored that
    /// says why.
    fn step_down<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// [`step_down`](RoutineControl::step_down) inside the caller's job.
    fn step_down_in(&self, tx: &dyn Tx, out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), Error>;
    fn pause<'a>(&'a self, routine_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// [`pause`](RoutineControl::pause) inside the caller's job.
    fn pause_in(&self, tx: &dyn Tx, out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), Error>;
    /// Resumes every routine paused for `reason`; one paused because a
    /// target was refused stays paused while its head names a recipient the
    /// user has not confirmed.
    fn resume_paused<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// Resumes the routine if it is paused for `reason`, inside the
    /// caller's job (the user resumed it from its alert); refused while a
    /// routine paused because a target was refused names a recipient the
    /// user has not confirmed. Writes nothing when refused.
    fn resume_in(&self, tx: &dyn Tx, out: &mut Outbox, routine_id: &str, reason: &str) -> Result<(), ResumeError>;
    /// The routines whose current version needs the capability.
    fn using_capability<'a>(&'a self, capability_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>>;
}

/// What a run's lead hands in with `submit_result`.
#[derive(Debug, Clone, PartialEq)]
pub struct SubmittedResult {
    /// What Makes names, or `nothing`.
    pub kind: String,
    pub headline: String,
    /// The result in the shape its kind asks for, or plain text.
    pub body: serde_json::Value,
    /// Paths of the files it carries, as the agent names them.
    pub files: Vec<String>,
}

/// A project milestone that a feature runs instead of the lead (01 G49):
/// `forge.test` names the step the Forge owns.
#[derive(Debug, Clone, PartialEq)]
pub struct SystemStepCall {
    pub step: String,
    pub run_id: String,
    pub routine_id: String,
    /// The milestone's key.
    pub milestone: String,
    /// What the run was started with.
    pub input: RunInput,
}

/// What a system step came to: a result that goes through the check and the
/// gate as a lead's does, or why the run fails.
#[derive(Debug, Clone, PartialEq)]
pub enum StepResult {
    Done(SubmittedResult),
    Failed { reason: String },
}

/// The steps the features that own built-in routines run (01 G49).
pub trait SystemSteps: Send + Sync {
    fn run(&self, call: SystemStepCall) -> BoxFuture<'_, Result<StepResult, Error>>;
    /// The folder the lead of a built-in routine's run `run_id` works in
    /// and shares with its team, made by the feature that owns the routine
    /// (the Forge's build folder); `None` leaves the lead its own.
    fn prepare_folder<'a>(&'a self, run_id: &'a str) -> BoxFuture<'a, Result<Option<String>, Error>> {
        let _ = run_id;
        Box::pin(std::future::ready(Ok(None)))
    }
}

/// No feature here owns a system step: each fails its run.
#[derive(Debug, Default)]
pub struct NoSystemSteps;

impl SystemSteps for NoSystemSteps {
    fn run(&self, call: SystemStepCall) -> BoxFuture<'_, Result<StepResult, Error>> {
        let reason = format!("No part of this Eos runs the step `{}`.", call.step);
        Box::pin(std::future::ready(Ok(StepResult::Failed { reason })))
    }
}

/// The routines Eos keeps for its own features (origin `builtin`): hidden
/// from the user's lists, never theirs to change (01 G49).
pub trait BuiltinRoutines: Send + Sync {
    /// Makes the built-in routine `slug` from `blueprint`, or keeps
    /// `blueprint` as its head when it changed; answers the routine's id.
    fn ensure<'a>(&'a self, slug: &'a str, blueprint: serde_json::Value) -> BoxFuture<'a, Result<String, Error>>;
}

/// A project's milestone a lead hands in (`complete_milestone`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MilestoneDone {
    /// The milestone's key: the one the run works on.
    pub key: String,
    /// What was done, as the user reads it.
    pub summary: String,
    /// Paths of the files it carries, as the agent names them.
    pub files: Vec<String>,
}

/// What the tools of a run's sessions do. Each call names the worker that
/// made it; a worker of no run, or of a run that is not at work, is refused.
pub trait RoutineTools: Send + Sync {
    /// Where the run is, in one line for the run view.
    fn report_progress<'a>(
        &'a self,
        worker_id: &'a str,
        line: &'a str,
        milestone: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// Keeps a copy of the result and its files, then moves the run to its
    /// check.
    fn submit_result<'a>(&'a self, worker_id: &'a str, result: SubmittedResult) -> BoxFuture<'a, Result<(), Error>>;
    /// A project run's lead hands in the milestone it works on: it goes
    /// through the check and the gate as a result does, then the run goes on
    /// with the next one.
    fn complete_milestone<'a>(&'a self, worker_id: &'a str, done: MilestoneDone) -> BoxFuture<'a, Result<(), Error>>;
    /// Ends the run as failed, the agent's reason its headline.
    fn report_failure<'a>(&'a self, worker_id: &'a str, reason: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The checker's verdict on the result it was given: a pass goes on, a
    /// fail goes back to the lead (once) or fails the run.
    fn submit_verdict<'a>(&'a self, worker_id: &'a str, verdict: CheckVerdict) -> BoxFuture<'a, Result<(), Error>>;
    /// A team lead starts the specialist `agent` of its routine on `task`.
    fn start_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
        task: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// A team lead's follow-up for a specialist it started.
    fn message_specialist<'a>(
        &'a self,
        worker_id: &'a str,
        agent: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// A team lead stops a specialist; its conversation is kept.
    fn stop_specialist<'a>(&'a self, worker_id: &'a str, agent: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The specialists of a team lead's routine and where each stands.
    fn list_specialists<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Vec<Specialist>, Error>>;
}

/// What `propose_blueprint` came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Proposal {
    /// Written as the routine's new draft version, with the warnings it was
    /// kept with.
    Drafted { version_id: String, warnings: Vec<BlueprintIssue> },
    /// The blueprint did not meet its rules; nothing was written.
    Refused(Vec<BlueprintIssue>),
}

/// What the tools of a routine's architect do. Each call names the worker
/// that made it; a worker that is no routine's architect is refused.
pub trait ArchitectTools: Send + Sync {
    /// The routine as it stands, its head and draft blueprints and its last
    /// trial runs, as JSON for the model.
    fn get_routine<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<serde_json::Value, Error>>;
    /// Writes `blueprint` as the routine's new draft version.
    fn propose_blueprint<'a>(
        &'a self,
        worker_id: &'a str,
        blueprint: serde_json::Value,
        note: Option<String>,
    ) -> BoxFuture<'a, Result<Proposal, Error>>;
    /// Puts one question with its choices on the draft for the user.
    fn ask_choice<'a>(
        &'a self,
        worker_id: &'a str,
        question: &'a str,
        choices: &'a [String],
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// Real items the draft would have taken, newest first.
    fn find_past_items<'a>(&'a self, worker_id: &'a str, limit: usize) -> BoxFuture<'a, Result<Vec<ItemRef>, Error>>;
    /// Starts the draft's trial; the ids of its runs.
    fn start_trial<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<Vec<String>, Error>>;
}

/// A routine as a chat's agent lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRoutine {
    pub slug: String,
    pub name: String,
    pub summary: String,
    /// What it takes, in the routine's own words (`a pull request`).
    pub takes: String,
    /// Whether an agent's start runs at once, without the user's click.
    pub agents_may_start: bool,
}

/// What a chat's agent asks to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRunAsk {
    /// The routine's slug, id or name.
    pub routine: String,
    pub item: Option<String>,
    pub note: Option<String>,
    pub show_only: bool,
}

/// What came of a chat's `run_routine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatStart {
    /// The routine lets agents start it: the run is queued.
    Started { run_id: String, routine_id: String, routine_name: String },
    /// The user starts it: the chat shows the filled form to confirm.
    Proposed { routine_id: String, routine_name: String },
}

/// What a chat's agent does with routines (`run_routine`, `list_routines`).
pub trait ChatRoutines: Send + Sync {
    /// The routines that take a run now.
    fn list(&self) -> BoxFuture<'_, Result<Vec<ChatRoutine>, Error>>;
    /// Starts the run when the routine lets agents start it, else proposes it.
    fn run<'a>(&'a self, worker_id: &'a str, ask: ChatRunAsk) -> BoxFuture<'a, Result<ChatStart, Error>>;
}

/// A specialist of a run's team, as its lead sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Specialist {
    /// Its key in the routine's Who.
    pub agent: String,
    pub name: String,
    /// `not_started`, `working`, `waiting` or `stopped`.
    pub state: &'static str,
    /// The first line of its last report this run, while Eos is up.
    pub last_report: Option<String>,
}

/// A file a result carries, as it was kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptFile {
    /// Its name in the run's `files/`.
    pub name: String,
    pub bytes: u64,
}

/// A run's folders under Eos's data folder, `routines/<routine>/runs/<run>/`:
/// `work/<n>/`, the empty folders an untrusted run's sessions work in, and
/// `files/`, the copies of what its result carries. No agent's file tool
/// writes either's parent entry.
pub trait RunFolders: Send + Sync {
    /// The routine's folder: its scripts and its runs' folders.
    fn routine_dir(&self, routine_id: &str) -> PathBuf;
    /// One run's folder, inside its routine's.
    fn run_dir(&self, routine_id: &str, run_id: &str) -> PathBuf;
    /// A new empty `work/<n>/` for one start of a session, `n` one past the
    /// highest there: nothing an earlier start left loads as instructions.
    /// Its absolute path.
    fn work_dir(&self, routine_id: &str, run_id: &str) -> Result<PathBuf, Error>;
    /// Copies each file into `files/` (never a link, never a folder, at most
    /// [`RUN_FILE_MAX_BYTES`] each); a name already taken gets a number.
    fn keep_files<'a>(
        &'a self,
        routine_id: &'a str,
        run_id: &'a str,
        files: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<KeptFile>, Error>>;
    /// Where a script routine's version keeps its script:
    /// `scripts/<versionId>.js` in the routine's folder.
    fn script_path(&self, routine_id: &str, version_id: &str) -> PathBuf;
    /// Writes the version's script there, replacing what is there.
    fn keep_script<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
        source: &'a str,
    ) -> BoxFuture<'a, Result<PathBuf, Error>>;
    /// The version's kept script as it is on disk; `None` when it is missing
    /// or is no plain file (a link is never followed).
    fn read_script<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Error>>;
}

/// The largest file a result carries.
pub const RUN_FILE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// How a checked result may go out, as the run asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateMode {
    /// As the routine's Freedom says.
    AsUsual,
    /// Held for the user whatever the Freedom says.
    Ask,
    /// Shown in Eos and sent nowhere.
    ShowOnly,
    /// A trial of a routine being made: sent nowhere.
    Trial,
}

/// A checked result at the gate, with what decides where it goes.
#[derive(Debug, Clone, PartialEq)]
pub struct GateInput {
    pub run_id: String,
    pub routine_id: String,
    /// The version the run runs from.
    pub version: String,
    /// What started the run (`hand`, `trigger`, …).
    pub origin: String,
    pub result_mode: GateMode,
    pub doc: ResultDoc,
    /// Where the run's version sends its results.
    pub targets: Vec<Recipient>,
    /// The item's fields, for the Goes-to bounds and the rung's caps.
    pub item_facts: serde_json::Value,
    /// What the item's source read about it (the signal's facts, `repo`,
    /// `draft`, …), for the Goes-to bounds and the grants. Never what a
    /// result may name.
    pub signal_facts: eos_contracts::Facts,
    /// The facts the item's source marks untrusted (a mail's `from`): Which
    /// may test them, but no grant or bound rests on them (D63).
    pub untrusted_facts: std::collections::BTreeSet<String>,
    /// The item's key: one subject's results replace each other.
    pub subject_key: Option<String>,
    pub trust: Trust,
    /// The Freedom of the version the user stands behind; none for a routine
    /// no such version has yet (a trial).
    pub freedom_confirmed: Option<Freedom>,
    pub goes_to_confirmed: Vec<Recipient>,
}

/// What the gate did with a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    /// Shown in Eos, sent nowhere: the run is done.
    Shown,
    /// Held for the user as a Needs-you item.
    Held { item_id: String },
    /// Going out: these deliveries send it.
    Delivering { delivery_ids: Vec<String> },
    /// It may not go where it would: the run ends.
    Refused,
}

/// Where a checked result goes (03 §4.8). Called inside the run's own write
/// job, so the decision, the run's state and its event commit together.
pub trait RunGate: Send + Sync {
    fn apply_in(
        &self,
        tx: &dyn Tx,
        out: &mut Outbox,
        now: i64,
        ids: &dyn Ids,
        input: &GateInput,
    ) -> Result<GateDecision, Error>;
    /// Takes back the run's result that waits for the user: the user told
    /// the team something, and the work reopens (01 G18).
    fn withdraw_in(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<(), Error>;
}

/// What became of a run's result after the gate, as the area that holds and
/// delivers it reports, inside its own write jobs.
pub trait RunOutcomes: Send + Sync {
    /// Its result waits for the user as `inbox_id`.
    fn held(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, inbox_id: &str) -> Result<(), Error>;
    /// The user sent it, or it goes out on its own.
    fn delivering(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str) -> Result<(), Error>;
    /// The run is done, its result `outcome`.
    fn finished(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, outcome: Outcome) -> Result<(), Error>;
    /// A delivery failed for good; `reason` is its kind.
    fn delivery_failed(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, reason: &str) -> Result<(), Error>;
    /// The user wants the result changed: the lead gets `text` and works
    /// again.
    fn revise(&self, tx: &dyn Tx, out: &mut Outbox, run_id: &str, text: &str) -> Result<(), Error>;
}

/// Whether the user's Claude plan is near its five-hour limit (01 G28):
/// runs from triggers wait then, runs by hand still start.
pub trait PlanHeadroom: Send + Sync {
    /// The cached five-hour window is at or above `percent` of the limit.
    fn busy(&self, percent: i64) -> bool;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_refusal_names_each_recipient_as_the_user_reads_it() {
        let recipients = [
            json!({"id": "me", "kind": "me", "channel": "push"}),
            json!({"id": "boss", "kind": "fixed", "channel": "mail", "address": "boss@acme.dev"}),
            json!({"id": "lead", "kind": "fixed", "channel": "github", "address": "octocat"}),
            json!({"id": "pr", "kind": "item_place", "channel": "github"}),
        ];
        let recipients = recipients.into_iter().map(|r| serde_json::from_value(r).expect("a recipient")).collect();
        let answer = serde_json::to_value(ResumeRefusal { recipients }.answer()).expect("json");
        assert_eq!(answer["code"], "recipients_unconfirmed");
        assert_eq!(
            answer["recipients"],
            json!([{"id": "me", "label": "you"}, {"id": "boss", "label": "boss@acme.dev"},
                   {"id": "lead", "label": "@octocat"}, {"id": "pr", "label": "the pull request"}])
        );
    }
}
