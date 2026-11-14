//! What the peer link announces, published on the bus.

use eos_contracts::stream::topics;
use eos_core::net::peer::{ConnectedDevice, PeerEvents};
use eos_runtime::bus::Bus;

use crate::{HOSTS_CHANGE, HostsChange, PEER_PRESENCE, PeerPresence, PresentDevice};

#[derive(Clone)]
pub struct BusEvents {
    bus: Bus,
}

impl std::fmt::Debug for BusEvents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BusEvents")
    }
}

impl BusEvents {
    pub fn new(bus: Bus) -> Self {
        Self { bus }
    }
}

impl PeerEvents for BusEvents {
    fn presence(&self, devices: Vec<ConnectedDevice>) {
        let devices =
            devices.into_iter().map(|d| PresentDevice { fp: d.fp, name: d.name, device_id: d.device_id }).collect();
        self.bus.publish(&PEER_PRESENCE, &PeerPresence { devices });
    }

    fn host_changed(&self, host_id: &str) {
        self.bus.publish(&HOSTS_CHANGE, &HostsChange { id: host_id.to_owned() });
    }

    /// A controlled computer's notification, raised here so this computer's
    /// window shows it; its `host` says which computer to switch to.
    fn notification(&self, payload: serde_json::Value) {
        if let Ok(json) = serde_json::to_vec(&payload) {
            self.bus.publish_raw(topics::NOTIFICATION_FIRE, None, json.into());
        }
    }
}
