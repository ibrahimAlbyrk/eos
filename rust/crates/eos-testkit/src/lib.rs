//! What tests share. A dev-dependency only: never part of the app.
//!
//! - [`FakeClock`]: time that moves when the test says so.
//! - [`SeqIds`]: ids in today's shapes that count up (`w-00000001`).
//! - [`TempHome`]: a data folder that is removed when dropped.
//! - [`TempStore`]: the real store over a migrated `state.db`, in a [`TempHome`];
//!   [`Announced`] keeps what its writes announced.
//! - [`fixtures`]: the recorded wire and the invented seed rows.
//! - [`FakePolicyFile`]: a policy file held in memory.
//! - [`FakeProfileRenderer`]: a user profile block that is one fixed text.
//! - [`update`]: the update fixtures and the generators of their inputs.
//! - [`wire::Replay`]: a recorded scenario replayed against a router.
//! - [`FakePageStore`], [`FakeUserProfileStore`], [`FakeUserAvatarStore`], [`FakeUserMemoryStore`],
//!   [`FakeMemoryProvider`]: the file-store ports, in memory.
//!
//! - [`FakeMedia`], [`FakeMap`], [`FakeGeocoder`], [`FakePlaceSearch`], [`FakeLocation`]: what visual
//!   answers reach outside for.
//!
//! - [`ScriptedRuntime`]: agent sessions that play scripted turns of canonical
//!   events, with no model ([`agent`]).
//! - [`FakeTerminals`], [`FakeShellCommands`], [`FakeTranscripts`], [`FakeClaudeProgram`], [`FakeClaudeEnv`]:
//!   the terminal ports — terminals and commands the test speaks for.
//!
//! A port's fake lives in `fakes`, named `Fake<Port>` ([`FakeModelCatalog`],
//! [`FakePolicy`], [`FakeCredentials`], [`FakeToolSets`], [`FakeUser`]);
//! [`FakeWatcher`] stands in for the folder watcher and the git watcher.
//! The accounts area's fakes are in `accounts` ([`FakePlanStores`], [`FakeSubscriptionProvider`], …).
//! [`plugins`] holds the fakes of the plugin ports. The update ports: [`FakeUpdateFeed`],
//! [`FakeUpdateSignature`], [`FakeBundleIndexer`], [`FakeUpdateWorkspace`], [`FakeBundleCheck`],
//! [`FakeTopLevelAgents`], [`FakeUpdateApplier`].
//!
//! Tests may panic on a broken set-up, so this crate uses `expect` freely.

#![allow(clippy::missing_panics_doc)]

mod accounts;
pub mod agent;
mod clock;
mod db;
mod fakes;
mod files;
pub mod fixtures;
mod genui;
mod home;
mod ids;
pub mod plugins;
mod policy;
mod profile;
mod terminal;
pub mod update;
mod update_fakes;
mod watchers;
pub mod wire;

pub use accounts::{
    FakeBrowser, FakeConfig, FakeLocalTime, FakePlanLoginDirs, FakePlanLoginStore, FakePlanStores, FakePlanUsageApi,
    FakeSecrets, FakeSessionSwitch, FakeSleeper, FakeSubscriptionProvider, FakeTokenProbe, FakeUsageProvider,
    FakeUsageSnapshots, StartedSignIn,
};
pub use agent::{RecordingSink, ScriptedRuntime, Turn};
pub use clock::FakeClock;
pub use db::{Announced, TempStore};
pub use fakes::{
    EchoTool, FakeCredentials, FakeModelCatalog, FakePolicy, FakePrompts, FakeRecents, FakeScratch, FakeSettings,
    FakeToolSets, FakeUser, FakeWorktrees,
};
pub use files::{FakeMemoryProvider, FakePageStore, FakeUserAvatarStore, FakeUserMemoryStore, FakeUserProfileStore};
pub use genui::{FakeGeocoder, FakeLocation, FakeMap, FakeMedia, FakePlaceSearch};
pub use home::TempHome;
pub use ids::SeqIds;
pub use policy::FakePolicyFile;
pub use profile::FakeProfileRenderer;
pub use terminal::{
    FakeClaudeEnv, FakeClaudeProgram, FakePty, FakeRun, FakeShellCommands, FakeTerminals, FakeTranscripts,
};
pub use update_fakes::{
    FAKE_DOWNLOAD_BYTES, FakeBundleCheck, FakeBundleIndexer, FakeTopLevelAgents, FakeUpdateApplier, FakeUpdateFeed,
    FakeUpdateSignature, FakeUpdateWorkspace,
};
pub use watchers::FakeWatcher;
