//! The short id people compare: the first 80 bits of the fingerprint in
//! Crockford base32, in groups of four ("7K3F-9QXM-2D8A-LP4C").

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn is_fingerprint(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    let nibble = |b: u8| char::from(b).to_digit(16).map_or(0, |d| d as u8);
    hex.as_bytes().as_chunks::<2>().0.iter().map(|[high, low]| (nibble(*high) << 4) | nibble(*low)).collect()
}

fn base32_crockford(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let (mut value, mut bits) = (0u32, 0u32);
    for b in bytes {
        value = ((value << 8) | u32::from(*b)) & 0xffff;
        bits += 8;
        while bits >= 5 {
            out.push(char::from(CROCKFORD[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(CROCKFORD[((value << (5 - bits)) & 31) as usize]));
    }
    out
}

/// Sixteen characters in four groups: enough for a person to spot a swapped
/// key; software pins the whole fingerprint.
pub fn format_device_id(fingerprint_hex: &str) -> String {
    let chars = base32_crockford(&hex_bytes(fingerprint_hex.get(..20).unwrap_or(fingerprint_hex)));
    let groups: Vec<&str> = chars.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    groups.join("-")
}

pub fn short_device_id(fingerprint_hex: &str) -> String {
    format_device_id(fingerprint_hex).chars().take(9).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_is_64_lower_case_hex_characters() {
        assert!(is_fingerprint(&"a1".repeat(32)));
        assert!(!is_fingerprint(&"A1".repeat(32)));
        assert!(!is_fingerprint(&"a1".repeat(31)));
        assert!(!is_fingerprint(&"g1".repeat(32)));
    }

    // Values printed by `formatDeviceId` / `shortDeviceId` (core/src/domain/peer.ts).
    #[test]
    fn device_ids_equal_what_typescript_prints() {
        let cases = [
            ("0000000000000000000000000000000000000000000000000000000000000000", "0000-0000-0000-0000"),
            ("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "ZZZZ-ZZZZ-ZZZZ-ZZZZ"),
            ("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "04HM-ASW9-NF6Y-Y093"),
            ("deadbeefcafef00d1234deadbeefcafef00d1234deadbeefcafef00d12345678", "VTPV-XVYA-ZVR0-T4HM"),
        ];
        for (fp, id) in cases {
            assert_eq!(format_device_id(fp), id, "{fp}");
            assert_eq!(short_device_id(fp), &id[..9]);
        }
    }
}
