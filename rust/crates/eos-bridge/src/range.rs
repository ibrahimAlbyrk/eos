//! `Range: bytes=…` for bodies the shell holds whole (dashboard files).

/// What a `Range` header selects in a body of `len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slice {
    /// No usable range: answer 200 with the whole body.
    Whole,
    /// Answer 206 with bytes `first..=last`.
    Part { first: u64, last: u64 },
    /// The range starts past the end: answer 416.
    Unsatisfiable,
}

/// Reads a single-range `bytes=` header. Several ranges, other units and malformed values
/// select the whole body, as a server that ignores `Range` would.
pub fn slice(header: Option<&str>, len: u64) -> Slice {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Slice::Whole };
    if spec.contains(',') {
        return Slice::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else { return Slice::Whole };
    match (first.trim(), last.trim()) {
        ("", "") => Slice::Whole,
        // A suffix: the last N bytes.
        ("", suffix) => match suffix.parse::<u64>() {
            Ok(0) => Slice::Unsatisfiable,
            Ok(_) if len == 0 => Slice::Unsatisfiable,
            Ok(n) => Slice::Part { first: len.saturating_sub(n), last: len - 1 },
            Err(_) => Slice::Whole,
        },
        (first, last) => {
            let Ok(first) = first.parse::<u64>() else { return Slice::Whole };
            let last = if last.is_empty() {
                len.saturating_sub(1)
            } else {
                match last.parse::<u64>() {
                    Ok(last) => last.min(len.saturating_sub(1)),
                    Err(_) => return Slice::Whole,
                }
            };
            if first >= len {
                Slice::Unsatisfiable
            } else if first > last {
                Slice::Whole
            } else {
                Slice::Part { first, last }
            }
        }
    }
}

/// The `Content-Range` value for a part.
pub fn content_range(first: u64, last: u64, len: u64) -> String {
    format!("bytes {first}-{last}/{len}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_header_or_another_unit_is_the_whole_body() {
        assert_eq!(slice(None, 100), Slice::Whole);
        assert_eq!(slice(Some("items=0-4"), 100), Slice::Whole);
        assert_eq!(slice(Some("bytes=abc-4"), 100), Slice::Whole);
        assert_eq!(slice(Some("bytes=0-1,5-9"), 100), Slice::Whole);
        assert_eq!(slice(Some("bytes=-"), 100), Slice::Whole);
        assert_eq!(slice(Some("bytes=9-4"), 100), Slice::Whole);
    }

    #[test]
    fn closed_and_open_ranges() {
        assert_eq!(slice(Some("bytes=0-0"), 100), Slice::Part { first: 0, last: 0 });
        assert_eq!(slice(Some("bytes=10-19"), 100), Slice::Part { first: 10, last: 19 });
        assert_eq!(slice(Some("bytes=10-"), 100), Slice::Part { first: 10, last: 99 });
        assert_eq!(slice(Some(" bytes=10 - 19 "), 100), Slice::Part { first: 10, last: 19 });
    }

    #[test]
    fn the_end_is_clamped_to_the_body() {
        assert_eq!(slice(Some("bytes=90-500"), 100), Slice::Part { first: 90, last: 99 });
    }

    #[test]
    fn suffix_ranges_take_the_tail() {
        assert_eq!(slice(Some("bytes=-10"), 100), Slice::Part { first: 90, last: 99 });
        assert_eq!(slice(Some("bytes=-500"), 100), Slice::Part { first: 0, last: 99 });
        assert_eq!(slice(Some("bytes=-0"), 100), Slice::Unsatisfiable);
    }

    #[test]
    fn a_start_past_the_end_cannot_be_satisfied() {
        assert_eq!(slice(Some("bytes=100-"), 100), Slice::Unsatisfiable);
        assert_eq!(slice(Some("bytes=0-"), 0), Slice::Unsatisfiable);
        assert_eq!(slice(Some("bytes=-5"), 0), Slice::Unsatisfiable);
    }

    #[test]
    fn content_range_value() {
        assert_eq!(content_range(10, 19, 100), "bytes 10-19/100");
    }
}
