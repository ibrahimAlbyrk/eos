//! The release pointer (`stable/<platform>.json`): `{ payload, signature }`,
//! where `payload` is the pointer's JSON as a string and the signature is
//! Ed25519 over that string verbatim — what was signed is exactly what is
//! parsed, with no canonical form to agree on. The signature itself is checked
//! by the caller's key store; the rest of `CheckForUpdate.ts` is here.

use eos_contracts::update::{SignedUpdatePointer, UpdatePlatform, UpdatePointer};
use eos_contracts::validate;

use super::error::{UpdateError, UpdateErrorCode};
use super::version::is_newer_version;

/// Reads the wrapper the feed serves.
pub fn parse_signed_pointer(json: &[u8]) -> Result<SignedUpdatePointer, UpdateError> {
    let value: serde_json::Value = serde_json::from_slice(json)
        .map_err(|_| UpdateError::bad_release("the feed sent something that is not JSON"))?;
    validate::parse(&value).map_err(|_| UpdateError::bad_release("the release pointer is malformed"))
}

/// The release a pointer offers this install: `None` when it is not newer
/// than `current`. `signature_ok` is the caller's verdict on the wrapper's
/// signature; nothing of the payload is read without it.
pub fn offered_release(
    signed: &SignedUpdatePointer,
    signature_ok: bool,
    platform: UpdatePlatform,
    current: &str,
) -> Result<Option<UpdatePointer>, UpdateError> {
    if !signature_ok {
        return Err(UpdateError::new(UpdateErrorCode::BadSignature, "the release pointer's signature does not verify"));
    }
    let value: serde_json::Value = serde_json::from_str(&signed.payload)
        .map_err(|_| UpdateError::bad_release("the release pointer is not JSON"))?;
    let pointer: UpdatePointer =
        validate::parse(&value).map_err(|_| UpdateError::bad_release("the release pointer is malformed"))?;
    if pointer.platform != platform {
        return Err(UpdateError::bad_release(format!(
            "the release pointer is for {}, not {}",
            platform_name(pointer.platform),
            platform_name(platform)
        )));
    }
    Ok(is_newer_version(&pointer.version.0, current).then_some(pointer))
}

/// The feed's name for a platform (`darwin-arm64`).
pub fn platform_name(platform: UpdatePlatform) -> &'static str {
    match platform {
        UpdatePlatform::DarwinArm64 => "darwin-arm64",
        UpdatePlatform::Win32X64 => "win32-x64",
        UpdatePlatform::Win32Arm64 => "win32-arm64",
    }
}

/// The platform a feed name stands for.
pub fn platform_named(name: &str) -> Option<UpdatePlatform> {
    [UpdatePlatform::DarwinArm64, UpdatePlatform::Win32X64, UpdatePlatform::Win32Arm64]
        .into_iter()
        .find(|p| platform_name(*p) == name)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn signed(payload: serde_json::Value) -> SignedUpdatePointer {
        SignedUpdatePointer { payload: payload.to_string(), signature: "s".into() }
    }

    fn pointer() -> serde_json::Value {
        json!({
            "version": "0.1.3", "platform": "darwin-arm64",
            "manifest": { "path": "releases/0.1.3/darwin-arm64.manifest.json.zst", "sha256": "a".repeat(64), "size": 10 },
            "releasedAt": "2026-10-29T12:00:00.000Z",
        })
    }

    #[test]
    fn a_signed_newer_release_for_this_platform_is_offered() {
        let mac = UpdatePlatform::DarwinArm64;
        let offered = offered_release(&signed(pointer()), true, mac, "0.1.2").expect("checked").expect("offered");
        assert_eq!(offered.version.0, "0.1.3");
        assert_eq!(offered_release(&signed(pointer()), true, mac, "0.1.3").expect("checked"), None);

        let code = |r: Result<Option<UpdatePointer>, UpdateError>| r.expect_err("refused").code;
        assert_eq!(code(offered_release(&signed(pointer()), false, mac, "0.1.2")), UpdateErrorCode::BadSignature);
        let mut other = pointer();
        other["platform"] = json!("win32-x64");
        let err = offered_release(&signed(other), true, mac, "0.1.2").expect_err("refused");
        assert_eq!(err.message, "the release pointer is for win32-x64, not darwin-arm64");
        assert_eq!(
            code(offered_release(&signed(json!({ "version": "nope" })), true, mac, "0.1.2")),
            UpdateErrorCode::BadRelease
        );
        let not_json = SignedUpdatePointer { payload: "{".into(), signature: "s".into() };
        assert_eq!(
            offered_release(&not_json, true, mac, "0.1.2").expect_err("refused").message,
            "the release pointer is not JSON"
        );
    }

    #[test]
    fn a_feed_path_may_not_climb_and_the_feed_may_only_move_to_https() {
        let mac = UpdatePlatform::DarwinArm64;
        let mut climbing = pointer();
        climbing["manifest"]["path"] = json!("releases/../../etc/passwd");
        assert!(offered_release(&signed(climbing), true, mac, "0.1.2").is_err());
        let mut plain = pointer();
        plain["feedUrl"] = json!("http://feed.example");
        assert!(offered_release(&signed(plain), true, mac, "0.1.2").is_err());
        let mut moved = pointer();
        moved["feedUrl"] = json!("https://feed.example");
        let offered = offered_release(&signed(moved), true, mac, "0.1.2").expect("checked").expect("offered");
        assert_eq!(offered.feed_url.as_deref(), Some("https://feed.example"));
    }

    #[test]
    fn the_wrapper_must_carry_a_64_byte_signature() {
        let good = format!(r#"{{"payload":"{{}}","signature":"{}=="}}"#, "A".repeat(86));
        assert!(parse_signed_pointer(good.as_bytes()).is_ok());
        let short = r#"{"payload":"{}","signature":"AAAA"}"#;
        assert_eq!(
            parse_signed_pointer(short.as_bytes()).expect_err("short").message,
            "the release pointer is malformed"
        );
        assert_eq!(
            parse_signed_pointer(b"not found").expect_err("text").message,
            "the feed sent something that is not JSON"
        );
    }

    #[test]
    fn every_platform_has_its_feed_name() {
        for name in eos_contracts::update::UPDATE_PLATFORMS {
            assert_eq!(platform_named(name).map(platform_name), Some(*name));
        }
        assert_eq!(platform_named("linux-x64"), None);
    }
}
