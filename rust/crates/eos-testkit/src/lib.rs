//! What tests share. A dev-dependency only: never part of the app.
//!
//! - [`FakeClock`]: time that moves when the test says so.
//! - [`SeqIds`]: ids in today's shapes that count up (`w-00000001`).
//! - [`TempHome`]: a data folder that is removed when dropped.
//! - [`TempStore`]: the real store over a migrated `state.db`, in a [`TempHome`];
//!   [`Announced`] keeps what its writes announced.
//! - [`fixtures`]: the recorded wire and the invented seed rows.
//! - [`wire::Replay`]: a recorded scenario replayed against a router.
//! - [`FakePageStore`], [`FakeUserProfileStore`], [`FakeUserAvatarStore`], [`FakeUserMemoryStore`],
//!   [`FakeMemoryProvider`]: the file-store ports, in memory.
//!
//! - [`ScriptedRuntime`]: agent sessions that play scripted turns of canonical
//!   events, with no model ([`agent`]).
//!
//! A port's fake lives in `fakes`, named `Fake<Port>` ([`FakeModelCatalog`]).
//!
//! Tests may panic on a broken set-up, so this crate uses `expect` freely.

#![allow(clippy::missing_panics_doc)]

pub mod agent;
mod clock;
mod db;
mod fakes;
mod files;
pub mod fixtures;
mod home;
mod ids;
pub mod wire;

pub use agent::{RecordingSink, ScriptedRuntime, Turn};
pub use clock::FakeClock;
pub use db::{Announced, TempStore};
pub use fakes::FakeModelCatalog;
pub use files::{FakeMemoryProvider, FakePageStore, FakeUserAvatarStore, FakeUserMemoryStore, FakeUserProfileStore};
pub use home::TempHome;
pub use ids::SeqIds;
