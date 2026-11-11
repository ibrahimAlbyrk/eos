//! Committed writes announce themselves on the bus.

use eos_core::store::{Announcement, Announcer};
use eos_runtime::bus::Bus;

/// Called on the database's writer thread after each COMMIT. Publishing from
/// that one thread is what makes "row written" events arrive in commit order;
/// a publish from off the lane only queues, so the writer never waits for
/// subscribers (only for room on the lane when it is full).
pub(crate) struct BusAnnouncer(pub(crate) Bus);

impl Announcer for BusAnnouncer {
    fn announce(&self, events: Vec<Announcement>) {
        for event in events {
            self.0.publish_raw(event.topic, None, event.payload.into());
        }
    }
}
