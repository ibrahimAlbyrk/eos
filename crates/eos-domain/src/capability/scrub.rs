//! A capability's secrets cut from what its code said, before a result
//! reaches a model, a log or the wire. Each secret of 8 characters or more
//! goes as it is and in the forms code puts it in: base64, URL-encoded and
//! JSON-escaped. Shorter values are too likely to stand in ordinary text.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// What a secret is replaced with.
pub const SCRUBBED: &str = "[secret]";

/// The fewest characters a value has to be scrubbed.
pub const MIN_CHARS: usize = 8;

/// `text` with every form of every secret replaced by [`SCRUBBED`].
pub fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut forms: Vec<String> = secrets
        .iter()
        .filter(|secret| secret.chars().count() >= MIN_CHARS)
        .flat_map(|secret| forms_of(secret))
        .collect();
    // The longest first, so a form inside a longer one never splits it.
    forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    forms.dedup();
    forms.iter().fold(text.to_owned(), |text, form| text.replace(form.as_str(), SCRUBBED))
}

fn forms_of(secret: &str) -> [String; 5] {
    let base64 = STANDARD.encode(secret);
    let unpadded = base64.trim_end_matches('=').to_owned();
    let json = serde_json::to_string(secret).unwrap_or_default();
    let json = json.get(1..json.len().saturating_sub(1)).unwrap_or_default().to_owned();
    [secret.to_owned(), base64, unpadded, encode_uri_component(secret), json]
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_goes_in_every_form_code_puts_it_in() {
        let secret = "s3cr3t/to+k\"en";
        let base64 = "czNjcjN0L3RvK2siZW4="; // base64 of the secret
        let cases = [
            (format!("token {secret} end"), "token [secret] end"),
            (format!("auth: {base64}"), "auth: [secret]"),
            (format!("auth: {}", base64.trim_end_matches('=')), "auth: [secret]"),
            ("https://x.test/?t=s3cr3t%2Fto%2Bk%22en&a=1".to_owned(), "https://x.test/?t=[secret]&a=1"),
            (r#"{"token":"s3cr3t/to+k\"en"}"#.to_owned(), r#"{"token":"[secret]"}"#),
            (format!("{secret}{secret}"), "[secret][secret]"),
        ];
        for (text, scrubbed) in cases {
            assert_eq!(scrub(&text, &[secret]), scrubbed, "{text}");
        }
    }

    #[test]
    fn short_values_and_other_text_stay() {
        assert_eq!(scrub("pin 1234567 and a token", &["1234567"]), "pin 1234567 and a token", "7 characters stay");
        assert_eq!(scrub("pin 12345678", &["12345678"]), "pin [secret]");
        assert_eq!(scrub("nothing here", &["abcdefghij"]), "nothing here");
        assert_eq!(scrub("nothing here", &[]), "nothing here");
        assert_eq!(scrub("çöğüşıİé1", &["çöğüşıİé"]), "[secret]1", "counted in characters, not bytes");
    }

    #[test]
    fn a_secret_inside_another_goes_with_the_longer_one() {
        let text = "a=abcdefgh-ijklmnop b=abcdefgh";
        assert_eq!(scrub(text, &["abcdefgh", "abcdefgh-ijklmnop"]), "a=[secret] b=[secret]");
    }
}
