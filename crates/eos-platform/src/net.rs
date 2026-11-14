//! What the network stack says about this computer: the addresses others can
//! reach it at, and the system's name for a failed connect.

use std::io;
use std::net::IpAddr;

/// Every address of this computer that another one could dial: each
/// non-loopback interface's IPv4 and IPv6 addresses.
pub fn network_addresses() -> Vec<IpAddr> {
    match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces.into_iter().filter(|i| !i.is_loopback()).map(|i| i.ip()).collect(),
        Err(_) => Vec::new(),
    }
}

/// The system's name for why a network call failed (`ECONNREFUSED`), as the
/// dashboard's copy and the link's diagnostics know it; `UNKNOWN` otherwise.
pub fn net_error_code(e: &io::Error) -> &'static str {
    #[cfg(unix)]
    if let Some(errno) = e.raw_os_error().map(rustix::io::Errno::from_raw_os_error) {
        use rustix::io::Errno;
        let named = [
            (Errno::HOSTUNREACH, "EHOSTUNREACH"),
            (Errno::NETUNREACH, "ENETUNREACH"),
            (Errno::CONNREFUSED, "ECONNREFUSED"),
            (Errno::HOSTDOWN, "EHOSTDOWN"),
            (Errno::TIMEDOUT, "ETIMEDOUT"),
            (Errno::CONNRESET, "ECONNRESET"),
            (Errno::NETDOWN, "ENETDOWN"),
            (Errno::ADDRNOTAVAIL, "EADDRNOTAVAIL"),
        ];
        if let Some((_, name)) = named.iter().find(|(known, _)| *known == errno) {
            return name;
        }
    }
    match e.kind() {
        io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
        io::ErrorKind::HostUnreachable => "EHOSTUNREACH",
        io::ErrorKind::NetworkUnreachable => "ENETUNREACH",
        io::ErrorKind::TimedOut => "ETIMEDOUT",
        io::ErrorKind::ConnectionReset => "ECONNRESET",
        _ => "UNKNOWN",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_connect_is_named_as_the_system_names_it() {
        // A port nothing listens on: bind, read the port, close.
        let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).expect("a free port").port();
        let err = std::net::TcpStream::connect(("127.0.0.1", port)).expect_err("nothing listens there");
        assert_eq!(net_error_code(&err), "ECONNREFUSED");
        assert_eq!(net_error_code(&io::Error::other("something else")), "UNKNOWN");
    }

    #[test]
    fn no_loopback_address_is_listed() {
        assert!(network_addresses().iter().all(|a| !a.is_loopback()));
    }
}
