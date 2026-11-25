//! Ports over the data folder: the repositories of `state.db` and the file
//! stores.
//!
//! # The database
//!
//! Repositories are synchronous and exist only inside a job handed to the
//! [`Store`]: a [`Tx`] is the set of repositories over one transaction.
//!
//! ```ignore
//! // A read: one consistent snapshot, on a read-only connection.
//! let worker = store.read(move |tx| tx.workers().find(&id)).await?;
//!
//! // A read-modify-write: one job, so nothing can change between its steps.
//! // What it announces goes out after COMMIT, in commit order.
//! store.write(move |tx, out| {
//!     tx.workers().update_name(&id, Some(&name), NameSource::User)?;
//!     out.push("worker:change", &WorkerChange { worker_id: id });
//!     Ok(())
//! }).await?;
//! ```
//!
//! A job that returns `Err` leaves no trace: its changes are undone and its
//! announcements dropped. A job must not block on anything but the database
//! and must not call the store again.
//!
//! A new table gets a repository trait in a file here, an accessor on [`Tx`],
//! and its implementation in `eos-store-sqlite`.
//!
//! # Files
//!
//! A file store is a `Send + Sync` trait a feature holds as `Arc<dyn …>`; it
//! keeps the file's format and guards its own read-modify-write
//! (`eos-store-files`, `eos-config`).
//!
//! A store of many small documents (pages, memories) holds what it loaded
//! and writes each change through; the one service that owns the data's write
//! path orders the changes.

mod capabilities;
mod conversation_lists;
mod counters;
mod definitions;
mod documents;
mod events;
mod files;
mod inbox;
mod mem;
mod mem_journal;
mod memories;
mod message_queue;
mod pages;
mod pending;
mod profile;
mod reactions;
mod remote;
mod retention;
mod routines;
mod runs;
mod session;
mod signals;
mod surfaces;
mod templates;
mod unit;
mod workers;

pub use capabilities::{
    CAPABILITY_CALLS_KEPT_MS, CAPABILITY_CALLS_MAX, CapabilityCallRepo, CapabilityInstallRepo, CapabilityVersionRepo,
    StoredCall, StoredCapabilityVersion, StoredInstall,
};
pub use conversation_lists::ConversationListRepo;
pub use counters::{ContextMarkRepo, MessageIdRepo, WorktreeRemoval, WorktreeRemovalQueue};
pub use definitions::{DefinitionFile, WorkerDefinitionFiles};
pub use documents::{DreamRepo, GenuiViewRepo, StoredViewState, TransferRepo, WorkerDefinitionRepo};
pub use events::{EventOrder, EventQuery, EventRepo};
pub use files::{ConfigSource, ProjectMemoryStore, ProjectStore, RecentFolders, UserSettingsStore};
pub use inbox::{
    DeliveryRepo, EditRepo, HaltRepo, InboxRepo, ItemAnswer, ItemPlace, ItemQuery, NewEdit, NewOutcome, OfferRepo,
    OutcomeRepo, StoredDelivery, StoredEdit, StoredHalt, StoredItem, StoredOffer, StoredOutcome, WaitingCount,
};
pub use mem::{
    LiveCount, MEM_EVIDENCE_PER_NOTE, MEM_NOTES_MAX, MemCreditRepo, MemEvidenceRepo, MemGraphRepo, MemNoteRepo,
    MemVectorRepo, MemVersionRepo, NoteQuery, StoredCredit, StoredEvidence, StoredHook, StoredLink, StoredNote,
    StoredNoteVersion, StoredVector, WordHit,
};
pub use mem_journal::{
    DailyCall, DailyCalls, MEM_FORGOTTEN_KEPT_MS, MEM_MOMENTS_DONE_KEPT_MS, MEM_USES_KEPT_MS, MemBookRepo,
    MemCursorRepo, MemMomentRepo, MemUseRepo, StoredForgotten, StoredMoment, StoredReplay, StoredStated, StoredUse,
};
pub use memories::UserMemoryStore;
pub use message_queue::{MessageQueueRepo, NewQueuedMessage};
pub use pages::PageStore;
pub use pending::{NewPending, PendingRepo, UserDenial};
pub use profile::{AvatarThumbnails, UserAvatar, UserAvatarStore, UserProfileStore};
pub use reactions::{ReactionRepo, StoredReaction};
pub use remote::{HookIdentity, RemoteAuditEntry, RemoteAuditResult, RemoteStore, RoomSecrets};
pub use retention::{EndedRun, Leaving, LeavingRoutine, RoutineRetentionRepo};
pub use routines::{
    RoutineRepo, RoutineSessionRepo, RoutineSpendRepo, RoutineSuggestionRepo, RoutineVersionRepo, StoredDraft,
    StoredRoutine, StoredRoutineSession, StoredSpend, StoredSuggestion, StoredVersion,
};
pub use runs::{
    EndedCount, RUN_EVENTS_MAX, RUN_STATE_EVENT, RunCounts, RunMove, RunRepo, RunResultRepo, StoredRun, StoredRunEvent,
    StoredRunResult, StoredSyncedRun, SyncedRunRepo,
};
pub use session::{AgentCaller, agent_caller, session_project, session_root};
pub use signals::{
    BatchedSignal, MANUAL_SCOPE_HASH, ManualSignal, NewSignal, SignalAskRepo, SignalHookRepo, SignalRepo,
    SignalRetentionRepo, SignalRouteRepo, SignalRunnerRepo, SignalScheduleRepo, SignalSourceRepo, SignalTally,
    SlotTally, StoredSignal, StoredSignalRoute, StoredSignalRunner, StoredSignalSchedule, StoredSignalSource,
};
pub use surfaces::{
    ActionLogRepo, StoredActionRecord, StoredIssue, StoredSurface, StoredSurfaceEdit, StoredSurfaceState,
    StoredSurfaceVersion, SurfaceEditRepo, SurfaceIssueRepo, SurfacePinRepo, SurfaceRepo, SurfaceStateRepo,
    SurfaceVersionRepo,
};
pub use templates::TemplateStore;
pub use unit::{Announcement, Announcer, Outbox, ReadJob, Store, Tx, WriteJob};
pub use workers::{NewWorker, PermissionFacts, WorkerRepo};
