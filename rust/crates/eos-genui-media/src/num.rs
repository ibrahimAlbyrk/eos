//! Numbers as JavaScript prints and rounds them, where the adapters' output
//! depends on it (coordinates in a query, a distance label).

/// `x.toFixed(digits)` for a finite `x` of ordinary size: the decimal closest
/// to `x`, a tie going to the larger one.
pub(crate) fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".to_owned()
        } else if x > 0.0 {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        };
    }
    // Enough digits to be exact for every value these adapters see, so a tie
    // is told apart from a near-tie.
    let exact = format!("{:.80}", x.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    if fraction.as_bytes().get(digits).is_some_and(|next| *next >= b'5') {
        // Half or more: away from zero (for a positive number, the larger).
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let mut out = String::with_capacity(kept.len() + 2);
    // "-0.000" keeps its sign in JavaScript only when the value is not zero.
    if x < 0.0 {
        out.push('-');
    }
    out.push_str(&String::from_utf8_lossy(&kept[..split]));
    if digits > 0 {
        out.push('.');
        out.push_str(&String::from_utf8_lossy(&kept[split..]));
    }
    out
}

/// `Math.round(x)`: a half goes up.
pub(crate) fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The first `max` UTF-16 code units of `s` (`s.slice(0, max)`); half a pair
/// reads as U+FFFD.
pub(crate) fn head16(s: &str, max: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_as_javascript_does() {
        // Checked in Node: (x).toFixed(d).
        for (x, digits, want) in [
            (40.98765, 3, "40.988"),
            (-0.0004, 3, "-0.000"),
            (179.9996, 3, "180.000"),
            (1.0005, 3, "1.000"),
            (2.0015, 3, "2.002"),
            (12.3455, 3, "12.345"),
            (-12.3455, 3, "-12.345"),
            (0.0625, 3, "0.063"),
            (0.1875, 3, "0.188"),
            (5.0, 3, "5.000"),
            (0.0, 3, "0.000"),
            (9.95, 1, "9.9"),
            (0.95, 1, "0.9"),
            (9.951, 1, "10.0"),
            (10.5, 0, "11"),
            (10.499, 0, "10"),
            (123.456, 0, "123"),
            (-33.8688197, 6, "-33.868820"),
            (151.2092955, 6, "151.209295"),
            (0.5, 0, "1"),
            (2.5, 0, "3"),
        ] {
            assert_eq!(to_fixed(x, digits), want, "{x} to {digits}");
        }
    }

    #[test]
    fn rounding_and_cutting() {
        assert_eq!((round(2.5), round(-2.5), round(2.4), round(-0.4)), (3.0, -2.0, 2.0, 0.0));
        assert_eq!(head16("a😀b", 2), "a\u{fffd}");
        assert_eq!((len16("a😀b"), head16("abc", 9)), (4, "abc".to_owned()));
    }
}
