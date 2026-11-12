//! This computer's position, read by a small native helper the app ships
//! (`app/location/main.swift`, run as `app/src/main/location.ts` runs it).
//!
//! A browser's own geolocation never reaches the system's location service
//! inside an embedded view, so the helper asks — showing the system's prompt
//! once — and prints one line of JSON:
//!
//! ```text
//! {"lat":…,"lon":…,"accuracy":…,"at":<ms>}
//! {"error":"denied|restricted|disabled|timeout|unavailable","message":"…"}
//! ```

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::host::Argv;
use crate::tool;

/// How long the helper waits for a fix: long enough to answer the first-time prompt.
pub const LOCATION_WAIT_SECONDS: u32 = 25;
/// The helper ends itself at its own deadline; this is for one that hangs.
const GRACE: Duration = Duration::from_secs(3);

/// One fix, as the helper printed it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocationReading {
    pub lat: f64,
    pub lon: f64,
    /// Metres.
    pub accuracy: f64,
    /// When the system took it (epoch milliseconds); `None` when the helper did not say.
    pub at_ms: Option<i64>,
}

/// Why there is no fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationFailure {
    /// The user refused, or a policy restricts it.
    Denied,
    /// Location services are off for the whole computer.
    Disabled,
    Timeout,
    Unavailable,
    /// This build ships no helper.
    Unsupported,
}

/// Reads what the helper printed: its last line.
pub fn parse_location(stdout: &str) -> Result<LocationReading, LocationFailure> {
    let line = stdout.trim().lines().next_back().unwrap_or_default();
    let Ok(serde_json::Value::Object(answer)) = serde_json::from_str::<serde_json::Value>(line) else {
        return Err(LocationFailure::Unavailable);
    };
    if let Some(error) = answer.get("error").and_then(|e| e.as_str()).filter(|e| !e.is_empty()) {
        return Err(match error {
            "denied" | "restricted" => LocationFailure::Denied,
            "disabled" => LocationFailure::Disabled,
            "timeout" => LocationFailure::Timeout,
            "unsupported" => LocationFailure::Unsupported,
            _ => LocationFailure::Unavailable,
        });
    }
    let number = |key: &str| answer.get(key).and_then(serde_json::Value::as_f64).filter(|n| n.is_finite());
    let (Some(lat), Some(lon), Some(accuracy)) = (number("lat"), number("lon"), number("accuracy")) else {
        return Err(LocationFailure::Unavailable);
    };
    #[allow(clippy::cast_possible_truncation)]
    let at_ms = number("at").map(|at| at.round() as i64);
    Ok(LocationReading { lat, lon, accuracy, at_ms })
}

/// Runs the helper and waits for its answer: as long as the user takes to
/// answer a permission prompt, at most the helper's own deadline. Blocks.
pub fn read_location(helper: &Argv) -> Result<LocationReading, LocationFailure> {
    if !Path::new(&helper.file).exists() {
        return Err(LocationFailure::Unsupported);
    }
    let wait = Duration::from_secs(u64::from(LOCATION_WAIT_SECONDS)) + GRACE;
    match tool::run("eos-location", Command::new(&helper.file).args(&helper.args), None, wait) {
        Ok(out) if out.status.success() || !out.stdout.trim().is_empty() => parse_location(&out.stdout),
        _ => Err(LocationFailure::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helpers_line_is_read() {
        let fix = parse_location("{\"lat\":40.9876,\"lon\":29.0321,\"accuracy\":35.5,\"at\":1760000000000.4}\n");
        assert_eq!(
            fix,
            Ok(LocationReading { lat: 40.9876, lon: 29.0321, accuracy: 35.5, at_ms: Some(1_760_000_000_000) })
        );
        // Only the last line counts; a fix without a time is still a fix.
        let fix = parse_location("warming up\n{\"lat\":1,\"lon\":2,\"accuracy\":3}\n").expect("a fix");
        assert_eq!((fix.lat, fix.lon, fix.accuracy, fix.at_ms), (1.0, 2.0, 3.0, None));
    }

    #[test]
    fn the_helpers_refusals_are_told_apart() {
        for (line, want) in [
            (r#"{"error":"denied","message":"location access denied"}"#, LocationFailure::Denied),
            (r#"{"error":"restricted","message":"location access restricted"}"#, LocationFailure::Denied),
            (r#"{"error":"disabled","message":"Location Services are off"}"#, LocationFailure::Disabled),
            (r#"{"error":"timeout","message":"no location within 25 s"}"#, LocationFailure::Timeout),
            (r#"{"error":"unavailable"}"#, LocationFailure::Unavailable),
            (r#"{"error":"unsupported"}"#, LocationFailure::Unsupported),
            (r#"{"error":"something new"}"#, LocationFailure::Unavailable),
            (r#"{"lat":"x","lon":2,"accuracy":3}"#, LocationFailure::Unavailable),
            (r#"{"lat":1,"lon":2}"#, LocationFailure::Unavailable),
            ("not json", LocationFailure::Unavailable),
            ("", LocationFailure::Unavailable),
            ("[1,2,3]", LocationFailure::Unavailable),
        ] {
            assert_eq!(parse_location(line), Err(want), "{line}");
        }
    }

    /// A stand-in for the helper: a script that prints what the real one would.
    #[cfg(unix)]
    fn fake_helper(dir: &Path, script: &str) -> Argv {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join("eos-location");
        std::fs::write(&file, format!("#!/bin/sh\n{script}\n")).expect("the script");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).expect("executable");
        Argv { file: file.to_string_lossy().into_owned(), args: vec!["25".to_owned()] }
    }

    #[cfg(unix)]
    #[test]
    fn the_helper_is_run_and_its_answer_read() {
        let dir = tempfile::tempdir().expect("a folder");
        let ok = fake_helper(dir.path(), r#"echo "{\"lat\":1.5,\"lon\":2.5,\"accuracy\":10,\"at\":$1}""#);
        // The script echoes its first argument as the time: the wait in seconds.
        assert_eq!(read_location(&ok), Ok(LocationReading { lat: 1.5, lon: 2.5, accuracy: 10.0, at_ms: Some(25) }));
        let denied = fake_helper(dir.path(), r#"echo '{"error":"denied","message":"location access denied"}'"#);
        assert_eq!(read_location(&denied), Err(LocationFailure::Denied));
        let crashed = fake_helper(dir.path(), "exit 3");
        assert_eq!(read_location(&crashed), Err(LocationFailure::Unavailable));
        let missing = Argv { file: dir.path().join("nope").to_string_lossy().into_owned(), args: Vec::new() };
        assert_eq!(read_location(&missing), Err(LocationFailure::Unsupported));
    }
}
