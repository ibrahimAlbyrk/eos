//! Which addresses the guarded fetch may connect to. Everything that is not a
//! public unicast address is refused: loopback, private, link-local, CGNAT,
//! multicast, documentation and benchmark ranges, IPv6 unique-local /
//! link-local / site-local, and the IPv4 embedded in mapped, compatible, NAT64
//! and 6to4 IPv6 forms.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

const fn v4(a: u8, b: u8, c: u8, d: u8) -> u32 {
    u32::from_be_bytes([a, b, c, d])
}

/// (base, prefix bits)
const V4_BLOCKED: &[(u32, u32)] = &[
    (v4(0, 0, 0, 0), 8), // "this network"
    (v4(10, 0, 0, 0), 8),
    (v4(100, 64, 0, 0), 10), // CGNAT
    (v4(127, 0, 0, 0), 8),
    (v4(169, 254, 0, 0), 16), // link-local (cloud metadata lives here)
    (v4(172, 16, 0, 0), 12),
    (v4(192, 0, 0, 0), 24),
    (v4(192, 0, 2, 0), 24),
    (v4(192, 88, 99, 0), 24),
    (v4(192, 168, 0, 0), 16),
    (v4(198, 18, 0, 0), 15),
    (v4(198, 51, 100, 0), 24),
    (v4(203, 0, 113, 0), 24),
    (v4(224, 0, 0, 0), 4), // multicast
    (v4(240, 0, 0, 0), 4), // reserved + broadcast
];

fn v4_blocked(address: u32) -> bool {
    V4_BLOCKED.iter().any(|(base, bits)| (address ^ base) >> (32 - bits) == 0)
}

const fn v6(groups: [u16; 8]) -> u128 {
    let mut value = 0u128;
    let mut i = 0;
    while i < 8 {
        value = (value << 16) | groups[i] as u128;
        i += 1;
    }
    value
}

/// Where the IPv4 address sits inside an IPv6 one.
#[derive(Clone, Copy)]
enum Embedded {
    /// The last 32 bits.
    Low,
    /// Bits 16–47 (6to4).
    AfterPrefix,
}

/// (base, prefix bits, embedded IPv4 to judge instead). First match decides.
const V6_RANGES: &[(u128, u32, Option<Embedded>)] = &[
    (v6([0, 0, 0, 0, 0, 0xffff, 0, 0]), 96, Some(Embedded::Low)), // IPv4-mapped
    (v6([0; 8]), 96, Some(Embedded::Low)),                        // IPv4-compatible, ::, ::1
    (v6([0x64, 0xff9b, 0, 0, 0, 0, 0, 0]), 96, Some(Embedded::Low)), // NAT64
    (v6([0x2002, 0, 0, 0, 0, 0, 0, 0]), 16, Some(Embedded::AfterPrefix)), // 6to4
    (v6([0x64, 0xff9b, 1, 0, 0, 0, 0, 0]), 48, None),
    (v6([0x100, 0, 0, 0, 0, 0, 0, 0]), 64, None),      // discard
    (v6([0x2001, 0, 0, 0, 0, 0, 0, 0]), 23, None),     // IETF protocol assignments (Teredo, …)
    (v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]), 32, None), // documentation
    (v6([0x3fff, 0, 0, 0, 0, 0, 0, 0]), 20, None),     // documentation
    (v6([0xfc00, 0, 0, 0, 0, 0, 0, 0]), 7, None),      // unique local
    (v6([0xfe80, 0, 0, 0, 0, 0, 0, 0]), 10, None),     // link-local
    (v6([0xfec0, 0, 0, 0, 0, 0, 0, 0]), 10, None),     // site-local (deprecated)
    (v6([0xff00, 0, 0, 0, 0, 0, 0, 0]), 8, None),      // multicast
];

fn v6_blocked(address: u128) -> bool {
    for (base, bits, embedded) in V6_RANGES {
        if (address ^ base) >> (128 - bits) != 0 {
            continue;
        }
        return match embedded {
            None => true,
            // ::/96 holds :: and ::1 too — both land in 0.0.0.0/8.
            Some(Embedded::Low) => v4_blocked(address as u32),
            Some(Embedded::AfterPrefix) => v4_blocked((address >> 80) as u32),
        };
    }
    false
}

/// True for any address the guarded fetch must not reach.
pub fn is_blocked_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4_blocked(u32::from(v4)),
        IpAddr::V6(v6) => v6_blocked(u128::from(v6)),
    }
}

/// [`is_blocked_ip`] for an address as text (IPv6 with or without brackets,
/// a zone id dropped). Text that is not an address is refused.
pub fn is_blocked_address(address: &str) -> bool {
    if let Ok(v4) = address.parse::<Ipv4Addr>() {
        return is_blocked_ip(IpAddr::V4(v4));
    }
    let bare = address.strip_prefix('[').and_then(|a| a.strip_suffix(']')).unwrap_or(address);
    let bare = bare.split_once('%').map_or(bare, |(address, _zone)| address);
    match bare.parse::<Ipv6Addr>() {
        Ok(v6) => is_blocked_ip(IpAddr::V6(v6)),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The vectors of infra/src/__tests__/genui-net-guard.test.ts.
    const BLOCKED: &[&str] = &[
        "127.0.0.1",
        "127.255.255.254",
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "100.127.255.255",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.10",
        "192.0.0.8",
        "192.0.2.1",
        "198.18.0.1",
        "198.51.100.7",
        "203.0.113.9",
        "224.0.0.1",
        "239.255.255.250",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:10.0.0.1",
        "::ffff:c0a8:101",
        "::127.0.0.1",
        "64:ff9b::a00:1",
        "64:ff9b::192.168.0.1",
        "2002:c0a8:0101::1",
        "2002:7f00:1::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "fe80::1%en0",
        "fec0::1",
        "ff02::1",
        "2001:db8::1",
        "2001::1",
        "100::1",
        "[::1]",
        "not-an-ip",
        "",
    ];
    const OPEN: &[&str] = &[
        "1.1.1.1",
        "8.8.8.8",
        "93.184.216.34",
        "172.32.0.1",
        "100.128.0.1",
        "2606:4700:4700::1111",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "2002:808:808::1",
        "2a00:1450:4001::200e",
    ];

    #[test]
    fn everything_that_is_not_public_is_refused() {
        for address in BLOCKED {
            assert!(is_blocked_address(address), "{address:?} must be refused");
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for address in OPEN {
            assert!(!is_blocked_address(address), "{address} must be allowed");
        }
    }

    #[test]
    fn range_edges() {
        for (address, blocked) in [
            ("9.255.255.255", false),
            ("11.0.0.0", false),
            ("100.63.255.255", false),
            ("172.15.255.255", false),
            ("198.17.255.255", false),
            ("198.19.255.255", true),
            ("198.20.0.0", false),
            ("223.255.255.255", false),
            ("192.88.99.1", true),
            ("169.253.255.255", false),
            ("fbff::1", false),
            ("fe00::1", false),
            ("febf::1", true),
            ("2001:1ff::1", true),
            ("2001:200::1", false),
            ("3fff:fff::1", true),
            ("64:ff9b:1::1", true),
            ("64:ff9b:2::1", false),
            ("100:0:0:1::1", false),
        ] {
            assert_eq!(is_blocked_address(address), blocked, "{address}");
        }
    }

    #[test]
    fn an_embedded_dotted_quad_is_the_same_address_as_its_hex_form() {
        assert_eq!("::ffff:1.2.3.4".parse::<Ipv6Addr>(), "::ffff:102:304".parse::<Ipv6Addr>());
        assert!(!is_blocked_address("::ffff:1.2.3.4"));
        // Spellings a strict parser rejects are refused outright.
        assert!(is_blocked_address("127.1"));
        assert!(is_blocked_address("0x7f.0.0.1"));
        assert!(is_blocked_address("8.8.8.08"));
    }
}
