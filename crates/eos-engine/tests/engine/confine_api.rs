//! The engine confines a command of the host's own, publicly: what the
//! capability runner's confinement is built on.

use std::path::PathBuf;

use eos_agent_sdk::{ConfineError, ConfineGuard, ConfineReport, ConfineSpec, Confined, Sdk, Violation};

/// Names every part of the API, so a pin that loses one fails to build.
#[allow(dead_code)]
async fn confine_and_report(sdk: &Sdk, spec: ConfineSpec) -> Result<ConfineReport, ConfineError> {
    if !sdk.sandbox_available() {
        return Err(ConfineError::Unavailable);
    }
    let Confined { program: _, args: _, env: _, guard } = sdk.confine(spec).await?;
    let guard: ConfineGuard = guard;
    Ok(guard.finish().await)
}

#[test]
fn a_confinement_spec_is_plain_data() {
    let spec = ConfineSpec {
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), "true".into()],
        cwd: PathBuf::from("/tmp"),
        env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        read_paths: vec![PathBuf::from("/tmp/package")],
        write_paths: vec![PathBuf::from("/tmp/package/data")],
        hosts: vec!["api.github.com".into()],
        apple_events: Vec::new(),
        tmpdir: PathBuf::from("/tmp/call"),
        audit: false,
    };
    assert_eq!(spec.clone().env, spec.env);
    let report = ConfineReport {
        violations: vec![Violation::Exec { path: "/usr/bin/security".into() }],
        more: 0,
        watched: true,
    };
    assert_eq!(report.violations.len(), 1);
}
