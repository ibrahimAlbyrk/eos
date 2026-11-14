//! Bytes from a terminal as text, a read at a time. A read ends wherever the
//! kernel's buffer did, often inside a character: its first bytes wait for
//! the rest. Bytes that are not UTF-8 become U+FFFD, as Node's decoder
//! makes them.

/// How many bytes at the end of `bytes` start a character without finishing it (0–3).
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let b = bytes[bytes.len() - back];
        if b & 0xC0 == 0x80 {
            continue;
        }
        let needs = match b {
            0xF0..=0xF7 => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needs > back { back } else { 0 };
    }
    0
}

#[derive(Debug, Default)]
pub(crate) struct Utf8Stream {
    held: Vec<u8>,
}

impl Utf8Stream {
    /// The text of what is complete so far.
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        if self.held.is_empty() {
            let keep = incomplete_tail(bytes);
            let (now, later) = bytes.split_at(bytes.len() - keep);
            self.held.extend_from_slice(later);
            return String::from_utf8_lossy(now).into_owned();
        }
        let mut all = std::mem::take(&mut self.held);
        all.extend_from_slice(bytes);
        let keep = incomplete_tail(&all);
        self.held = all.split_off(all.len() - keep);
        String::from_utf8_lossy(&all).into_owned()
    }

    /// What was still waiting when the terminal closed.
    pub(crate) fn finish(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.held)).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_cut_anywhere_comes_out_whole() {
        let text = "aç 漢😀é\u{301}z";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            for cut2 in cut..=bytes.len() {
                let mut stream = Utf8Stream::default();
                let mut out = stream.push(&bytes[..cut]);
                out.push_str(&stream.push(&bytes[cut..cut2]));
                out.push_str(&stream.push(&bytes[cut2..]));
                out.push_str(&stream.finish());
                assert_eq!(out, text, "cut at {cut} and {cut2}");
            }
        }
    }

    #[test]
    fn bytes_that_are_not_text_become_replacement_characters() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.push(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(stream.push(b"\xe6\xbc"), "");
        assert_eq!(stream.finish(), "\u{FFFD}");
    }
}
