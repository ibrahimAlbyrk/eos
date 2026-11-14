//! Single-range `bytes=a-b` support for file bodies (media elements refuse to
//! seek without it).

use std::borrow::Cow;

use super::body::Body;
use super::response::Response;

/// An inclusive byte range inside a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }

    pub fn is_empty(&self) -> bool {
        false
    }
}

fn digits(s: &str) -> Option<Option<u64>> {
    if s.is_empty() {
        return Some(None);
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A number too large for u64 is past any file's end either way.
    Some(Some(s.parse().unwrap_or(u64::MAX)))
}

/// The range a `Range` header asks for in a file of `size` bytes; `None` means
/// "serve the whole file" (no header, several ranges, or one that cannot be met).
pub fn parse_byte_range(header: Option<&str>, size: u64) -> Option<ByteRange> {
    let header = header?.trim();
    if size == 0 {
        return None;
    }
    let (from, to) = header.strip_prefix("bytes=")?.split_once('-')?;
    match (digits(from)?, digits(to)?) {
        (None, None) => None,
        (None, Some(suffix)) => {
            let suffix = suffix.min(size);
            (suffix > 0).then(|| ByteRange { start: size - suffix, end: size - 1 })
        }
        (Some(start), end) => {
            if start >= size {
                return None;
            }
            let end = end.map_or(size - 1, |e| e.min(size - 1));
            (end >= start).then_some(ByteRange { start, end })
        }
    }
}

/// The response for a file of `size` bytes: 206 with `content-range` when the
/// request's `Range` header can be met, 200 otherwise. `body` gets the range
/// to read (`None` = the whole file).
pub fn file_response(
    content_type: impl Into<Cow<'static, str>>,
    size: u64,
    range_header: Option<&str>,
    body: impl FnOnce(Option<ByteRange>) -> Body,
) -> Response {
    let range = parse_byte_range(range_header, size);
    let mut res = Response::new(if range.is_some() { 206 } else { 200 })
        .header("content-type", content_type)
        .header("accept-ranges", "bytes");
    if let Some(r) = range {
        res = res.header("content-range", format!("bytes {}-{}/{size}", r.start, r.end));
    }
    res.header("content-length", range.map_or(size, |r| r.len()).to_string()).body(body(range))
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn r(start: u64, end: u64) -> Option<ByteRange> {
        Some(ByteRange { start, end })
    }

    #[test]
    fn parses_bounded_open_ended_and_suffix_ranges() {
        assert_eq!(parse_byte_range(Some("bytes=0-99"), 1000), r(0, 99));
        assert_eq!(parse_byte_range(Some("bytes=200-"), 1000), r(200, 999));
        assert_eq!(parse_byte_range(Some("bytes=-100"), 1000), r(900, 999));
        assert_eq!(parse_byte_range(Some(" bytes=0-0 "), 1000), r(0, 0));
    }

    #[test]
    fn clamps_the_end_to_the_file_size() {
        assert_eq!(parse_byte_range(Some("bytes=0-5000"), 1000), r(0, 999));
        assert_eq!(parse_byte_range(Some("bytes=-5000"), 1000), r(0, 999));
        assert_eq!(parse_byte_range(Some("bytes=0-99999999999999999999999"), 1000), r(0, 999));
    }

    #[test]
    fn rejects_invalid_or_unsatisfiable_ranges() {
        assert_eq!(parse_byte_range(None, 1000), None);
        assert_eq!(parse_byte_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(parse_byte_range(Some("bytes=-0"), 1000), None);
        assert_eq!(parse_byte_range(Some("bytes=5-2"), 1000), None);
        assert_eq!(parse_byte_range(Some("bytes=0-10,20-30"), 1000), None);
        assert_eq!(parse_byte_range(Some("bytes=0-"), 0), None);
        assert_eq!(parse_byte_range(Some("bytes=-"), 1000), None);
        assert_eq!(parse_byte_range(Some("items=0-5"), 1000), None);
        assert_eq!(parse_byte_range(Some("bytes=a-5"), 1000), None);
    }

    #[test]
    fn builds_whole_and_partial_file_responses() {
        let whole = file_response("video/mp4", 1000, None, |range| {
            assert_eq!(range, None);
            Body::Empty
        });
        assert_eq!(whole.status, 200);
        assert_eq!(whole.header_value("content-length"), Some("1000"));
        assert_eq!(whole.header_value("accept-ranges"), Some("bytes"));
        assert_eq!(whole.header_value("content-range"), None);

        let part = file_response("video/mp4", 1000, Some("bytes=200-299"), |range| {
            assert_eq!(range, r(200, 299));
            Body::Empty
        });
        assert_eq!(part.status, 206);
        assert_eq!(part.header_value("content-range"), Some("bytes 200-299/1000"));
        assert_eq!(part.header_value("content-length"), Some("100"));
    }
}
