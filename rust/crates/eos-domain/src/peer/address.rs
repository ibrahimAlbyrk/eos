//! A direct address as invites and the host list carry it: `host:port`, an
//! IPv6 host in brackets.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub host: String,
    pub port: u16,
}

fn port(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|p| *p > 0)
}

pub fn parse_address(addr: &str) -> Option<Address> {
    if let Some(rest) = addr.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let valid = !host.is_empty() && host.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
        return Some(Address { host: valid.then(|| host.to_owned())?, port: port(tail.strip_prefix(':')?)? });
    }
    let (host, tail) = addr.split_once(':')?;
    let valid = !host.is_empty() && !host.chars().any(|c| c.is_whitespace() || matches!(c, '[' | ']'));
    Some(Address { host: valid.then(|| host.to_owned())?, port: port(tail)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(addr: &str) -> Option<(String, u16)> {
        parse_address(addr).map(|a| (a.host, a.port))
    }

    // What `parseAddress` (infra/src/peer/machine.ts) answers.
    #[test]
    fn reads_host_and_port_and_refuses_the_rest() {
        assert_eq!(parsed("192.168.1.20:7402"), Some(("192.168.1.20".into(), 7402)));
        assert_eq!(parsed("office-imac.tail1234.ts.net:7402"), Some(("office-imac.tail1234.ts.net".into(), 7402)));
        assert_eq!(parsed("[fd7a:115c::1]:7402"), Some(("fd7a:115c::1".into(), 7402)));
        assert_eq!(parsed("[::ffff:10.0.0.1]:1"), Some(("::ffff:10.0.0.1".into(), 1)));
        for bad in [
            "office-imac",
            "host:",
            "host:0",
            "host:65536",
            "host:123456",
            "fd7a::1:7402",
            "[fd7a::1]7402",
            "[]:1",
            "a b:1",
            ":1",
        ] {
            assert_eq!(parsed(bad), None, "{bad}");
        }
    }
}
