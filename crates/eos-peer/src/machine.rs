//! Facts about this computer that peering shows to others.

use std::net::IpAddr;

/// Where a device on this network (or tailnet) can reach `port` here: every
/// address of a non-loopback interface. Link-local IPv6 is skipped — it needs
/// a zone id a peer on another interface cannot use.
pub(crate) fn direct_addresses(port: u16) -> Vec<String> {
    eos_platform::network_addresses()
        .into_iter()
        .filter_map(|addr| match addr {
            IpAddr::V4(v4) => Some(format!("{v4}:{port}")),
            IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => None,
            IpAddr::V6(v6) => Some(format!("[{v6}]:{port}")),
        })
        .collect()
}

/// What changes when this computer moves to another network.
pub(crate) fn network_fingerprint() -> String {
    let mut addrs: Vec<String> = eos_platform::network_addresses().iter().map(ToString::to_string).collect();
    addrs.sort();
    addrs.join(",")
}
