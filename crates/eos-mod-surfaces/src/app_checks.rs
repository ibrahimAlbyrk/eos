//! An App's review and tests (05 Q7), once it passed Eos's scan: Eos starts
//! the read-only App reviewer in the build run, with its list, the App and
//! the scan, and draws the App in the probe with a fake bridge that answers
//! and records every call, at a phone's width. Each half is kept on the
//! version as it ends, in one write; once both are in, both passing makes
//! the version the candidate the user keeps or not, and anything else
//! discards it with its report. The builder is told either way. Without
//! Eos's window the tests wait, as a page design's do.
//!
//! Not guaranteed: Eos's own checks inside the frame (errors, drawing,
//! width, the builder's tests) run beside the App's code, which could hide
//! an error from them; only the undeclared-call check runs outside it. A
//! reviewer that ends without a verdict leaves the version waiting, never
//! shown, until the builder hands in another.

use std::sync::Arc;

use eos_contracts::{ToolScope, WorkerDefinitionRecord};
use eos_core::Error;
use eos_core::routine::AppReviewStart;
use eos_core::surface::ProbeDoc;
use eos_surface::{APP_TEST_CSP, APP_TEST_JS, APP_TEST_WIDTH, AppDesign, Level, VersionStatus, app_test_document};
use serde_json::{Value, json};

use crate::design::{Designs, announce};

/// One App version just written as `checking`, and who built it.
pub(crate) struct Checking {
    pub(crate) surface_id: String,
    pub(crate) title: String,
    pub(crate) version: i64,
    pub(crate) run_id: String,
    pub(crate) builder: String,
    pub(crate) app: AppDesign,
}

/// Starts both halves; neither holds up the builder's call.
pub(crate) fn begin(designs: &Arc<Designs>, checking: Checking) {
    let designs = designs.clone();
    tokio::spawn(async move {
        if let Err(error) = review(&designs, &checking).await {
            tracing::warn!(surface = %checking.surface_id, version = checking.version, %error, "an App's reviewer could not start");
        }
        if let Err(error) = designs.test_app(&checking.surface_id, checking.version).await {
            tracing::warn!(surface = %checking.surface_id, version = checking.version, %error, "an App could not be tested");
        }
    });
}

/// The reviewer's first message: its list, then the App as outside text.
fn brief(definition: &WorkerDefinitionRecord, app: &AppDesign, access_line: &str) -> String {
    let body = app.to_body();
    let manifest = serde_json::to_string_pretty(&body["manifest"]).unwrap_or_default();
    let tests = app.tests.as_deref().unwrap_or("(none)");
    let app_text = format!("## Manifest\n\n{manifest}\n\n## Code\n\n{}\n\n## Tests\n\n{tests}", app.html);
    format!(
        "{}\n\n# The App\n\nEos's scan passed it. Eos writes this line under it for the user: {access_line}\n\n{}",
        definition.body.trim(),
        eos_domain::untrusted::wrap("app", &app_text)
    )
}

async fn review(designs: &Designs, checking: &Checking) -> Result<(), Error> {
    let parts = &designs.parts;
    let definition = &parts.app_reviewer;
    let line = crate::apps::access_line(parts, &checking.app.to_body().to_string()).unwrap_or_default();
    let start = AppReviewStart {
        run_id: checking.run_id.clone(),
        name: format!("{} · App review", checking.title),
        model: definition.model.clone().unwrap_or_else(|| "opus".into()),
        effort: definition
            .effort
            .and_then(|effort| serde_json::to_value(effort).ok())
            .and_then(|effort| effort.as_str().map(str::to_owned))
            .unwrap_or_else(|| "high".into()),
        fence: ToolScope {
            allow: definition.tools_allow.clone().unwrap_or_default(),
            deny: definition.tools_deny.clone().unwrap_or_default(),
            edit_regex: None,
        },
        brief: brief(definition, &checking.app, &line),
    };
    let Some(reviewer) = parts.reviews.start_reviewer(start).await? else {
        return Ok(());
    };
    let builder = checking.builder.clone();
    settle(designs, &checking.surface_id, checking.version, move |checks| {
        checks["reviewer"] = json!(reviewer);
        checks["builder"] = json!(builder);
    })
    .await
}

/// What a finished version tells its builder.
fn told(version: i64, passed: bool, checks: &Value) -> String {
    if passed {
        return format!("Version {version} of the App passed its review and its tests: the user can now keep it.");
    }
    let mut lines = Vec::new();
    if checks["review"]["verdict"] == "fail" {
        for finding in checks["review"]["findings"].as_array().into_iter().flatten() {
            let field = |key: &str| finding[key].as_str().unwrap_or_default().to_owned();
            lines.push(format!("- review, {} at {}: {}", field("rule"), field("where"), field("why")));
        }
        if lines.is_empty() {
            lines.push("- review: it did not pass".into());
        }
    }
    for finding in checks["tests"]["findings"].as_array().into_iter().flatten() {
        let field = |key: &str| finding[key].as_str().unwrap_or_default().to_owned();
        lines.push(format!("- tests, {}: {}", field("check"), field("detail")));
    }
    format!(
        "Version {version} of the App did not pass, so the user will not see it. Fix these points and hand in a \
         new version with app_propose:\n{}",
        lines.join("\n")
    )
}

/// Applies `change` to the checks of a version still `checking` as the
/// App's open candidate and, once its review and its tests are both in,
/// moves it on; the builder hears how it went. A version that moved on is
/// left as it is.
pub(crate) async fn settle(
    designs: &Designs,
    surface_id: &str,
    version: i64,
    change: impl FnOnce(&mut Value) + Send + 'static,
) -> Result<(), Error> {
    let sid = surface_id.to_owned();
    let ended = designs
        .parts
        .store
        .write(move |tx, out| {
            let Some(mut surface) = tx.surfaces().find(&sid)?.filter(|s| s.level == Level::App) else {
                return Ok(None);
            };
            let Some(mut row) = tx.surface_versions().find(&sid, version)? else { return Ok(None) };
            if row.status != VersionStatus::Checking || surface.candidate_version != Some(version) {
                return Ok(None);
            }
            let mut checks: Value = serde_json::from_str(&row.checks_json).unwrap_or_else(|_| json!({}));
            change(&mut checks);
            let review = checks["review"]["verdict"].as_str().map(|verdict| verdict == "pass");
            let tests = checks["tests"]["passed"].as_bool();
            let ended = match (review, tests) {
                (Some(review), Some(tests)) => Some(review && tests),
                _ => None,
            };
            if let Some(passed) = ended {
                checks["passed"] = json!(passed);
                row.status = if passed { VersionStatus::Candidate } else { VersionStatus::Discarded };
                if !passed {
                    surface.candidate_version = None;
                    tx.surfaces().put(&surface)?;
                }
            }
            row.checks_json = checks.to_string();
            tx.surface_versions().put(&row)?;
            let phase = match ended {
                Some(true) => "candidate",
                Some(false) => "failed",
                None => "checking",
            };
            announce(out, &surface, version, phase);
            let to = (row.run_id.clone(), checks["builder"].as_str().map(str::to_owned));
            Ok(ended.map(|passed| (passed, checks, to)))
        })
        .await?;
    let Some((passed, checks, (Some(run_id), Some(builder)))) = ended else { return Ok(()) };
    tracing::info!(surface = %surface_id, version, passed, "an App's review and tests ended");
    designs.parts.reviews.tell(&run_id, &builder, told(version, passed, &checks)).await
}

impl Designs {
    /// Draws an App version still `checking` in the probe with its tests and
    /// keeps what they found; waits without Eos's window.
    pub(crate) async fn test_app(&self, surface_id: &str, version: i64) -> Result<(), Error> {
        let sid = surface_id.to_owned();
        let row = self.parts.store.read(move |tx| tx.surface_versions().find(&sid, version)).await?;
        let Some(row) = row.filter(|row| row.status == VersionStatus::Checking) else { return Ok(()) };
        let checks: Value = serde_json::from_str(&row.checks_json).unwrap_or_default();
        if checks["tests"]["passed"].is_boolean() {
            return Ok(());
        }
        if !self.probe.is_available() {
            return self.tests_wait(surface_id, version).await;
        }
        let body: Value = serde_json::from_str(&row.body_json).unwrap_or_default();
        let app = AppDesign::from_body(&body, |_| true).map_err(|_| Error::storage("a checked App no longer reads"))?;
        let url = self.docs.hold_under(app_test_document(&app), Some(APP_TEST_CSP));
        let shots = self.root.join(surface_id).join("checks").join(version.to_string());
        let measured = {
            let _one = self.probing.lock().await;
            self.probe.measure(ProbeDoc { url, script: APP_TEST_JS.to_owned() }, &[APP_TEST_WIDTH], &shots).await
        };
        let widths = match measured {
            Ok(widths) => widths,
            Err(Error::Unreachable(_)) => return self.tests_wait(surface_id, version).await,
            Err(error) => return Err(error),
        };
        let findings: Vec<_> = widths.iter().flat_map(|w| w.findings.clone()).collect();
        let screenshot = widths.iter().find_map(|w| w.screenshot.as_ref()).map(|p| p.to_string_lossy().into_owned());
        let tests = json!({ "passed": findings.is_empty(), "width": APP_TEST_WIDTH, "findings": findings, "screenshot": screenshot });
        tracing::info!(surface = %surface_id, version, findings = findings.len(), "an App was tested");
        settle(self, surface_id, version, move |checks| checks["tests"] = tests).await
    }

    async fn tests_wait(&self, surface_id: &str, version: i64) -> Result<(), Error> {
        settle(self, surface_id, version, |checks| checks["tests"] = json!({ "waiting": "Waiting for Eos's window" }))
            .await
    }
}

/// The verdict of the App reviewer `worker_id`, kept on the App's open
/// version it was started for. The first verdict is the one kept.
pub(crate) async fn verdict(designs: &Designs, worker_id: &str, verdict: Value) -> Result<String, Error> {
    let kept = checked(&verdict).map_err(Error::Validation)?;
    let worker = worker_id.to_owned();
    let found = designs
        .parts
        .store
        .read(move |tx| {
            let reviews = tx.routine_sessions().find(&worker)?.is_some_and(|s| s.role == "app_reviewer");
            let Some(run) = tx.routine_sessions().run_of(&worker)?.filter(|_| reviews) else { return Ok(None) };
            for surface in tx.surfaces().list(Some(&run.routine_id), None)? {
                let Some(open) = surface.candidate_version.filter(|_| surface.level == Level::App) else { continue };
                let Some(row) = tx.surface_versions().find(&surface.id, open)? else { continue };
                let checks: Value = serde_json::from_str(&row.checks_json).unwrap_or_default();
                if row.status == VersionStatus::Checking && checks["reviewer"] == worker.as_str() {
                    return Ok(Some((surface.id, open, checks["review"].is_null())));
                }
            }
            Ok(None)
        })
        .await?;
    let Some((surface_id, version, open)) = found else {
        return Err(Error::Validation("app_review is for the reviewer of an App waiting for its review".into()));
    };
    if !open {
        return Ok(format!("version {version} already has its verdict"));
    }
    let pass = kept["verdict"] == "pass";
    settle(designs, &surface_id, version, move |checks| {
        if checks["review"].is_null() {
            checks["review"] = kept;
        }
    })
    .await?;
    Ok(format!("verdict recorded: {} for version {version}", if pass { "pass" } else { "fail" }))
}

/// The verdict as kept, or every problem with it.
fn checked(verdict: &Value) -> Result<Value, String> {
    let mut problems = Vec::new();
    let pass = match verdict["verdict"].as_str() {
        Some("pass") => true,
        Some("fail") => false,
        _ => {
            problems.push("verdict: is `pass` or `fail`".to_owned());
            false
        }
    };
    let mut findings = Vec::new();
    match verdict["findings"].as_array() {
        Some(list) => {
            for (n, finding) in list.iter().enumerate() {
                let field = |key: &str| finding[key].as_str().filter(|text| !text.trim().is_empty());
                match (field("rule"), field("where"), field("why")) {
                    (Some(rule), Some(at), Some(why)) => {
                        findings.push(json!({ "rule": rule, "where": at, "why": why }))
                    }
                    _ => problems.push(format!("findings[{n}]: has a rule, where and why")),
                }
            }
        }
        None => problems.push("findings: is a list, empty for a pass".to_owned()),
    }
    if pass && !findings.is_empty() {
        problems.push("findings: a pass breaks no rule, so it has none".to_owned());
    }
    if !pass && problems.is_empty() && findings.is_empty() {
        problems.push("findings: a fail names the rules it breaks".to_owned());
    }
    if problems.is_empty() {
        Ok(json!({ "verdict": verdict["verdict"], "findings": findings }))
    } else {
        Err(problems.join("\n"))
    }
}
