//! The phone link's other ends, for tests: a relay on a loopback port
//! ([`FakeRelay`], with the room rules of `relay/RoomRegistry.ts`), a phone
//! that speaks what the released iOS app speaks ([`FakePhone`]), and a room
//! held in memory for code that only needs the port ([`FakeRoom`],
//! [`FakeRelayPort`]). [`FakeRemoteStore`] and [`FakeKeepAwake`] stand in for
//! the link's files and for keeping the computer awake.

mod phone;
pub mod registry;
mod room;
mod server;
mod store;

pub use phone::{ControlAnswer, FakePhone, JoinFailure, PHONE_CAPS, Pairing, QrFailure, inner_json, read_qr};
pub use room::{FakeRelayPort, FakeRoom};
pub use server::{FakeRelay, FakeRelayOptions, Registration, free_port};
pub use store::{FakeKeepAwake, FakeRemoteStore};
