//! Port of `contracts/src/artifact-ids.ts`.
//!
//! One claude.ai Artifact has two URL forms that name the same uuid:
//! `claude.ai/code/artifact/<uuid>` and `claude.ai/artifact/<shortId>`, where
//! the short id is the uuid's 128 bits in base58 (Bitcoin alphabet), always 22
//! characters.

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SHORT_LEN: usize = 22;

fn is_uuid(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// The 22-character short id of a uuid, or `None` when `slug` is not one.
pub fn short_id_of(slug: &str) -> Option<String> {
    let id = slug.to_lowercase();
    if !is_uuid(&id) {
        return None;
    }
    let mut n = u128::from_str_radix(&id.replace('-', ""), 16).ok()?;
    let mut out = [0u8; SHORT_LEN];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(n % 58) as usize];
        n /= 58;
    }
    Some(out.iter().map(|b| char::from(*b)).collect())
}

/// The uuid a short id names, or `None` when it is not a short id.
pub fn slug_of_short_id(short_id: &str) -> Option<String> {
    if short_id.len() != SHORT_LEN {
        return None;
    }
    let mut n: u128 = 0;
    for c in short_id.bytes() {
        let digit = ALPHABET.iter().position(|a| *a == c)?;
        // 22 base58 digits can exceed 128 bits.
        n = n.checked_mul(58)?.checked_add(digit as u128)?;
    }
    let hex = format!("{n:032x}");
    Some(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// The artifact's uuid from either URL form, or `None` for any other URL.
pub fn artifact_slug_from_url(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let rest = rest.strip_prefix("preview.").unwrap_or(rest);
    let rest = rest.strip_prefix("claude.ai/").or_else(|| rest.strip_prefix("claude.com/"))?;
    let (code, rest) = match rest.strip_prefix("code/") {
        Some(r) => (true, r),
        None => (false, rest),
    };
    let rest = rest.strip_prefix("artifact/")?;
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).unwrap_or(rest.len());
    let (id, tail) = rest.split_at(end);
    if id.is_empty() || !(tail.is_empty() || tail.starts_with(['/', '?', '#'])) {
        return None;
    }
    if code {
        let id = id.to_lowercase();
        is_uuid(&id).then_some(id)
    } else {
        slug_of_short_id(id)
    }
}

/// The page claude.ai serves for an artifact (its share link).
pub fn artifact_viewer_url(slug: &str) -> String {
    format!("https://claude.ai/artifact/{}", short_id_of(slug).unwrap_or_else(|| slug.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // contracts/src/__tests__/artifact-ids.test.ts — a real pair.
    const SLUG: &str = "53b36e79-b067-412a-962e-60219d0e7186";
    const SHORT: &str = "BLUSnX4ryWVrJkeDQtv9mP";

    #[test]
    fn encodes_a_uuid_as_its_short_id_and_back() {
        assert_eq!(short_id_of(SLUG).as_deref(), Some(SHORT));
        assert_eq!(slug_of_short_id(SHORT).as_deref(), Some(SLUG));
    }

    #[test]
    fn keeps_leading_zero_bits_at_full_length() {
        let zero = "00000000-0000-0000-0000-000000000001";
        let short = short_id_of(zero).unwrap();
        assert_eq!(short.len(), 22);
        assert_eq!(slug_of_short_id(&short).as_deref(), Some(zero));
    }

    #[test]
    fn rejects_malformed_ids() {
        assert_eq!(short_id_of("not-a-uuid"), None);
        assert_eq!(slug_of_short_id("short"), None);
        assert_eq!(slug_of_short_id("0OIl0OIl0OIl0OIl0OIl0O"), None);
        assert_eq!(slug_of_short_id("zzzzzzzzzzzzzzzzzzzzzz"), None);
    }

    #[test]
    fn reads_the_uuid_from_either_url_form() {
        let slug = Some(SLUG.to_owned());
        assert_eq!(artifact_slug_from_url(&format!("https://claude.ai/artifact/{SHORT}")), slug);
        assert_eq!(artifact_slug_from_url(&format!("https://claude.ai/code/artifact/{SLUG}")), slug);
        assert_eq!(
            artifact_slug_from_url(&format!("https://claude.ai/code/artifact/{}?x=1", SLUG.to_uppercase())),
            slug
        );
        assert_eq!(artifact_slug_from_url(&format!("https://preview.claude.ai/artifact/{SHORT}#top")), slug);
        assert_eq!(artifact_slug_from_url("https://claude.ai/chat/abc"), None);
        assert_eq!(artifact_slug_from_url("https://example.com/artifact/BLUSnX4ryWVrJkeDQtv9mP"), None);
    }

    #[test]
    fn builds_the_viewer_url_from_the_short_id() {
        assert_eq!(artifact_viewer_url(SLUG), format!("https://claude.ai/artifact/{SHORT}"));
    }
}
