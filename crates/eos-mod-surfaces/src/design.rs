//! A page design on its way to the user (05 Q3): the static checks, then a
//! version written as `checking` (the surface's one open candidate; one
//! still open before it is discarded), then the probe draws it with each
//! data set at each width. Every check passing makes it the `candidate` the
//! user keeps or not; a failing one is `discarded` with its report. Without
//! Eos's window it waits in `checking`, and is checked when the app starts
//! again with a window. Each step is one write announced on
//! `surfaces:design`; the probe runs outside any write, one page at a time.

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::{SurfacesChange, SurfacesDesign};
use eos_core::Error;
use eos_core::store::{Outbox, StoredIssue, StoredSurface, StoredSurfaceVersion, Tx};
use eos_core::surface::PageProbe;
use eos_surface::render::IssueFacts;
use eos_surface::{IssueKind, Level, MadeBy, PageDesign, Problem, VersionStatus};
use serde_json::{Value, json};

use crate::design_checks::{data_sets, measure, report, static_checks};
use crate::{ProbeDocs, SURFACES_CHANGE, SURFACES_DESIGN, SurfacesParts};

/// What a maker hands in.
pub(crate) struct Proposal {
    pub(crate) surface_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) made_by: MadeBy,
    pub(crate) base_version: Option<i64>,
    pub(crate) note: String,
    pub(crate) body: Value,
}

/// What became of a proposal.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Proposed {
    /// The static checks failed; nothing was written.
    Refused(Vec<Problem>),
    /// Every check passed: the version is the surface's candidate.
    Candidate(i64),
    /// Written, and waiting for Eos's window to be checked.
    Waiting(i64),
    /// The probe found problems; the version was discarded with its report.
    Failed { version: i64, report: Value },
}

pub(crate) struct Designs {
    pub(crate) parts: Arc<SurfacesParts>,
    pub(crate) docs: Arc<ProbeDocs>,
    pub(crate) probe: Arc<dyn PageProbe>,
    /// `surfaces/`: each version's screenshots go under `<sf>/checks/<n>/`.
    pub(crate) root: PathBuf,
    /// One probe at a time: each is a whole renderer.
    pub(crate) probing: tokio::sync::Mutex<()>,
}

pub(crate) fn announce(out: &mut Outbox, surface: &StoredSurface, version: i64, phase: &str) {
    let design = SurfacesDesign { surface_id: surface.id.clone(), version, phase: phase.into() };
    out.push(SURFACES_DESIGN.name(), &design);
    let change = SurfacesChange {
        surface_id: surface.id.clone(),
        routine_id: surface.routine_id.clone(),
        what: "version".into(),
    };
    out.push(SURFACES_CHANGE.name(), &change);
}

/// The open candidate of `surface` is let go: a newer one takes its place.
pub(crate) fn discard_open(tx: &dyn Tx, surface: &StoredSurface) -> Result<(), Error> {
    let Some(open) = surface.candidate_version else { return Ok(()) };
    let Some(mut version) = tx.surface_versions().find(&surface.id, open)? else { return Ok(()) };
    if version.status.can_move_to(VersionStatus::Discarded) {
        version.status = VersionStatus::Discarded;
        tx.surface_versions().put(&version)?;
    }
    Ok(())
}

impl Designs {
    pub(crate) async fn propose(&self, proposal: Proposal) -> Result<Proposed, Error> {
        let design = match static_checks(&proposal.body, &self.parts.actions) {
            Ok(design) => design,
            Err(problems) => return Ok(Proposed::Refused(problems)),
        };
        let version = self.write_checking(proposal, &design).await?;
        self.check(&version.0, version.1).await
    }

    async fn write_checking(&self, p: Proposal, design: &PageDesign) -> Result<(String, i64), Error> {
        let body = design.to_body().to_string();
        let now = self.parts.clock.now_ms();
        let written = self
            .parts
            .store
            .write(move |tx, out| {
                let surface = tx.surfaces().find(&p.surface_id)?;
                let surface = surface.filter(|s| s.level == Level::Page && s.archived_at.is_none());
                let mut surface = surface.ok_or_else(|| Error::not_found("page", &p.surface_id))?;
                discard_open(tx, &surface)?;
                let version = tx.surface_versions().next_number(&surface.id)?;
                tx.surface_versions().put(&StoredSurfaceVersion {
                    surface_id: surface.id.clone(),
                    version,
                    status: VersionStatus::Checking,
                    base_version: p.base_version,
                    made_by: p.made_by,
                    run_id: p.run_id,
                    note: p.note,
                    body_bytes: body.len() as i64,
                    body_json: body,
                    checks_json: json!({ "passed": null }).to_string(),
                    created_at: now,
                    kept_at: None,
                })?;
                surface.candidate_version = Some(version);
                surface.updated_at = now;
                tx.surfaces().put(&surface)?;
                announce(out, &surface, version, "checking");
                Ok((surface.id, version))
            })
            .await?;
        tracing::info!(surface = %written.0, version = written.1, "a page design passed its static checks");
        Ok(written)
    }

    /// Runs the probe on a version still `checking`, and writes what it found.
    pub(crate) async fn check(&self, surface_id: &str, version: i64) -> Result<Proposed, Error> {
        let sid = surface_id.to_owned();
        let found = self
            .parts
            .store
            .read(move |tx| {
                let Some(surface) = tx.surfaces().find(&sid)? else { return Ok(None) };
                let Some(row) = tx.surface_versions().find(&sid, version)? else { return Ok(None) };
                let issues: Vec<StoredIssue> = tx.surface_issues().of_surface(&sid, None, 10)?;
                Ok(Some((surface, row, issues)))
            })
            .await?;
        let Some((surface, row, issues)) = found else { return Err(Error::not_found("version", version.to_string())) };
        if row.status != VersionStatus::Checking {
            return Err(Error::Conflict(format!("version {version} is no longer being checked")));
        }
        if !self.probe.is_available() {
            return self.waiting(&surface, version).await;
        }
        let body: Value = serde_json::from_str(&row.body_json).unwrap_or_default();
        let design = PageDesign::from_body(&body).map_err(|_| Error::storage("a checked design no longer reads"))?;
        let pages: Vec<StoredIssue> = issues.into_iter().filter(|i| i.kind == IssueKind::Page).collect();
        let sets = data_sets(&design, &pages);
        let now = self.parts.clock.now_ms();
        let offset = self.parts.zone.offset_minutes_at(now);
        let facts = IssueFacts {
            id: "probe".into(),
            seq: Some(1),
            date: crate::page::local_date(now, offset),
            reader: crate::page::reader_name(&self.parts),
        };
        let shots = self.root.join(&surface.id).join("checks").join(version.to_string());
        let measured = {
            let _one = self.probing.lock().await;
            measure(self.probe.as_ref(), &self.docs, &surface.id, &surface.title, &design, &sets, &facts, &shots).await
        };
        let measured = match measured {
            Ok(measured) => measured,
            Err(Error::Unreachable(_)) => return self.waiting(&surface, version).await,
            Err(error) => return Err(error),
        };
        let (passed, checks) = report(&measured);
        self.finish(&surface.id, version, passed, checks.clone()).await?;
        tracing::info!(surface = %surface.id, version, passed, sets = sets.len(), "a page design was probed");
        Ok(if passed { Proposed::Candidate(version) } else { Proposed::Failed { version, report: checks } })
    }

    async fn waiting(&self, surface: &StoredSurface, version: i64) -> Result<Proposed, Error> {
        let sid = surface.id.clone();
        self.parts
            .store
            .write(move |tx, out| {
                let Some(mut row) = tx.surface_versions().find(&sid, version)? else { return Ok(()) };
                let Some(surface) = tx.surfaces().find(&sid)? else { return Ok(()) };
                row.checks_json = json!({ "passed": null, "waiting": "Waiting for Eos's window" }).to_string();
                tx.surface_versions().put(&row)?;
                announce(out, &surface, version, "waiting");
                Ok(())
            })
            .await?;
        Ok(Proposed::Waiting(version))
    }

    async fn finish(&self, surface_id: &str, version: i64, passed: bool, checks: Value) -> Result<(), Error> {
        let sid = surface_id.to_owned();
        self.parts
            .store
            .write(move |tx, out| {
                let Some(mut row) = tx.surface_versions().find(&sid, version)? else { return Ok(()) };
                let Some(mut surface) = tx.surfaces().find(&sid)? else { return Ok(()) };
                // A newer proposal took its place meanwhile: it stays as it was.
                if row.status != VersionStatus::Checking || surface.candidate_version != Some(version) {
                    return Ok(());
                }
                row.status = if passed { VersionStatus::Candidate } else { VersionStatus::Discarded };
                row.checks_json = checks.to_string();
                tx.surface_versions().put(&row)?;
                if !passed {
                    surface.candidate_version = None;
                    tx.surfaces().put(&surface)?;
                }
                announce(out, &surface, version, if passed { "candidate" } else { "failed" });
                Ok(())
            })
            .await
    }

    /// Checks every candidate left waiting for the window.
    pub(crate) async fn check_waiting(&self) -> Result<(), Error> {
        if !self.probe.is_available() {
            return Ok(());
        }
        let waiting = self
            .parts
            .store
            .read(|tx| {
                let mut found = Vec::new();
                for surface in tx.surfaces().list(None, None)? {
                    let Some(open) = surface.candidate_version else { continue };
                    let row = tx.surface_versions().find(&surface.id, open)?;
                    if row.is_some_and(|row| row.status == VersionStatus::Checking) {
                        found.push((surface.id, surface.level, open));
                    }
                }
                Ok(found)
            })
            .await?;
        for (surface, level, version) in waiting {
            let checked = match level {
                Level::App => self.test_app(&surface, version).await,
                _ => self.check(&surface, version).await.map(drop),
            };
            if let Err(error) = checked {
                tracing::warn!(surface = %surface, version, %error, "a waiting page design could not be checked");
            }
        }
        Ok(())
    }
}
