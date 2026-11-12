//! Number and string behaviour of JavaScript that today's tool texts were
//! written with, where Rust's own differs.

/// `x.toFixed(digits)` for a finite, non-negative `x`: the decimal expansion
/// of the double itself, a tie going up.
pub(crate) fn to_fixed(x: f64, digits: usize) -> String {
    // Far more digits than a tie needs: what follows the cut decides.
    let exact = format!("{x:.40}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).map(|b| b - b'0').collect();
    let up = fraction.as_bytes().get(digits).is_some_and(|next| *next >= b'5');
    if up {
        let mut at = kept.len();
        loop {
            if at == 0 {
                kept.insert(0, 1);
                break;
            }
            at -= 1;
            if kept[at] == 9 {
                kept[at] = 0;
            } else {
                kept[at] += 1;
                break;
            }
        }
    }
    let text: String = kept.iter().map(|d| char::from(b'0' + d)).collect();
    if digits == 0 {
        return text;
    }
    let cut = text.len() - digits;
    format!("{}.{}", &text[..cut], &text[cut..])
}

/// `Math.round`: a half goes toward positive infinity.
pub(crate) fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `text.slice(0, max)`: the first `max` UTF-16 units; a character that
/// straddles the cut is left out.
pub(crate) fn slice_units(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

/// `text.trim()`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_the_double_itself() {
        // Values checked against `(x).toFixed(n)` in Node.
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.15, 1), "1.1", "1.15 is stored a little below");
        assert_eq!(to_fixed(1.05, 1), "1.1", "1.05 is stored a little above");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.4, 0), "0");
        assert_eq!(to_fixed(12.0, 0), "12");
        assert_eq!(to_fixed(999.5, 0), "1000");
    }

    #[test]
    fn slices_by_utf16_units() {
        assert_eq!(slice_units("héllo", 3), "hél");
        assert_eq!(slice_units("a😀b", 2), "a", "an emoji is two units");
        assert_eq!(slice_units("a😀b", 3), "a😀");
    }
}
