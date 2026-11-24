//! `fill_page`: a run of a routine whose surface is a Page hands its data in.
//! The core checks it against the contract of the version the run fills (a
//! trial fills the open candidate; any other run the version kept when it
//! started, so keeping a new one mid-run changes nothing for it) and answers
//! every problem at once. An accepted fill is the run's issue, `preparing`
//! while its images are fetched or read once and stored, then `ready`; a
//! second fill of the same run is a new revision of it. A run whose fills
//! were refused three times, or that has no kept design, gets a fallback
//! View built from its last data, and the surface is marked for a redesign;
//! two fallbacks in a row put one "page needs redesign" item in Needs you.

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::SurfacesIssue;
use eos_core::routine::RunRef;
use eos_core::store::{Outbox, StoredIssue, StoredSurface, Tx};
use eos_core::surface::ImageSource;
use eos_core::{BoxFuture, Error};
use eos_surface::limits::{FILL_ATTEMPTS, IMAGES_PER_ISSUE, ISSUE_DATA_BYTES};
use eos_surface::render::fallback::fallback_view;
use eos_surface::{
    Contract, IssueKind, IssueStatus, Level, PageDesign, Problem, Type, VersionStatus, format_problems, validate,
};
use serde_json::{Value, json};

use crate::page::IssueImage;
use crate::{SURFACES_ISSUE, SurfacesParts};

/// A run's refused fills so far, and the data it last sent.
#[derive(Default)]
pub(crate) struct Fills {
    tries: Mutex<HashMap<String, (u32, Value)>>,
}

/// What a fill is checked against.
struct Target {
    run: RunRef,
    surface: StoredSurface,
    version: Option<(i64, PageDesign)>,
}

pub(crate) fn announce(out: &mut Outbox, issue: &StoredIssue) {
    let change = SurfacesIssue {
        surface_id: issue.surface_id.clone(),
        issue_id: issue.id.clone(),
        status: issue.status.as_str().to_owned(),
        rev: issue.rev,
    };
    out.push(SURFACES_ISSUE.name(), &change);
}

/// The run's page surface and the design its fill is checked against.
fn target_in(tx: &dyn Tx, worker_id: &str) -> Result<Target, Error> {
    let run = tx.routine_sessions().run_of(worker_id)?;
    let run = run.ok_or_else(|| Error::Validation("fill_page is for a routine run's sessions".into()))?;
    let surface = tx.surfaces().of_routine(&run.routine_id)?.into_iter().find(|s| s.level == Level::Page);
    let surface = surface
        .ok_or_else(|| Error::Validation("this routine makes no page: hand in the result with submit_result".into()))?;
    let versions = tx.surface_versions().of_surface(&surface.id)?;
    let chosen = if run.kind == "trial" {
        surface.candidate_version.and_then(|n| versions.iter().find(|v| v.version == n))
    } else {
        versions
            .iter()
            .filter(|v| matches!(v.status, VersionStatus::Kept | VersionStatus::Superseded))
            .filter(|v| v.kept_at.is_some_and(|at| at <= run.started_at))
            .max_by_key(|v| v.kept_at)
    };
    let version = match chosen {
        None => None,
        Some(v) => {
            let body: Value = serde_json::from_str(&v.body_json).unwrap_or_default();
            PageDesign::from_body(&body).ok().map(|design| (v.version, design))
        }
    };
    Ok(Target { run, surface, version })
}

/// `9 stories · 4 images fetching`.
fn tally(contract: &Contract, data: &Value, images: usize) -> String {
    let mut parts: Vec<String> = contract
        .fields
        .iter()
        .filter(|f| matches!(f.ty, Type::List { .. }))
        .filter_map(|f| data.get(&f.name).and_then(Value::as_array).map(|items| format!("{} {}", items.len(), f.name)))
        .collect();
    if images > 0 {
        parts.push(format!("{images} image{} fetching", if images == 1 { "" } else { "s" }));
    }
    parts.join(" · ")
}

/// The `src` of every image the data holds, where the contract says images go.
fn image_srcs(ty: &Type, data: &Value, out: &mut Vec<String>) {
    match (ty, data) {
        (Type::Image, Value::Object(image)) => {
            if let Some(src) = image.get("src").and_then(Value::as_str)
                && !out.iter().any(|s| s == src)
            {
                out.push(src.to_owned());
            }
        }
        (Type::Object { fields }, Value::Object(map)) => {
            for field in fields {
                if let Some(value) = map.get(&field.name) {
                    image_srcs(&field.ty, value, out);
                }
            }
        }
        (Type::List { of, .. }, Value::Array(items)) => items.iter().for_each(|item| image_srcs(of, item, out)),
        _ => {}
    }
}

/// Where an image is had: a web address, or a file the run made in its own
/// folder, named relative to it.
fn source(src: &str, run_dir: &Path) -> Option<ImageSource> {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(ImageSource::Url(src.to_owned()));
    }
    let path = Path::new(src);
    let inside = !src.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    inside.then(|| ImageSource::RunFile(run_dir.join(path)))
}

impl Fills {
    fn refused(&self, run_id: &str, data: &Value) -> u32 {
        let mut tries = self.tries.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = tries.entry(run_id.to_owned()).or_insert((0, Value::Null));
        entry.0 += 1;
        entry.1 = data.clone();
        entry.0
    }

    fn forget(&self, run_id: &str) {
        self.tries.lock().unwrap_or_else(PoisonError::into_inner).remove(run_id);
    }
}

pub(crate) fn fill_page<'a>(
    parts: &'a Arc<SurfacesParts>,
    fills: &'a Arc<Fills>,
    worker_id: &'a str,
    data: Value,
) -> BoxFuture<'a, Result<String, Error>> {
    Box::pin(async move {
        let worker = worker_id.to_owned();
        let target = parts.store.read(move |tx| target_in(tx, &worker)).await?;
        if data.is_null() {
            return Ok(match &target.version {
                Some((n, design)) => format!(
                    "Version {n} of this page takes data of this contract:\n{}\n\nA sample that fits it:\n{}",
                    design.contract.to_json(),
                    design.sample
                ),
                None => "This page has no kept design yet: fill it with your data and it is shown plainly.".to_owned(),
            });
        }
        let Some((version, design)) = &target.version else {
            let line = fallback(parts, &target, &data, &[Problem::new("", "this page has no kept design yet")]).await?;
            return Ok(line);
        };
        let mut problems = validate(&design.contract.as_type(), &data).problems;
        let bytes = data.to_string().len();
        if bytes > ISSUE_DATA_BYTES {
            problems.push(Problem::new("", format!("is {bytes} bytes, max {ISSUE_DATA_BYTES}")));
        }
        let mut srcs = Vec::new();
        image_srcs(&design.contract.as_type(), &data, &mut srcs);
        if srcs.len() > IMAGES_PER_ISSUE {
            problems.push(Problem::new("", format!("holds {} images, max {IMAGES_PER_ISSUE}", srcs.len())));
        }
        for src in srcs.iter().filter(|src| source(src, &target.run.output_dir).is_none()) {
            problems.push(Problem::new("", format!("image {src}: an http(s) address or a file in your run's folder")));
        }
        if !problems.is_empty() {
            let tries = fills.refused(&target.run.run_id, &data);
            tracing::info!(surface = %target.surface.id, run_id = %target.run.run_id, problems = problems.len(), tries, "a fill was refused");
            if tries >= FILL_ATTEMPTS {
                fills.forget(&target.run.run_id);
                return fallback(parts, &target, &data, &problems).await;
            }
            let left = FILL_ATTEMPTS - tries;
            return Err(Error::Validation(format!(
                "{}\n\n{left} more refused fill{} and this issue is shown as a plain view.",
                format_problems(&problems),
                if left == 1 { "" } else { "s" }
            )));
        }
        fills.forget(&target.run.run_id);
        let images: Vec<IssueImage> =
            srcs.iter().map(|src| IssueImage { src: src.clone(), hash: None, failed: None }).collect();
        let issue = store_fill(parts, &target, *version, &data, &images).await?;
        tracing::info!(surface = %issue.surface_id, issue = %issue.id, rev = issue.rev, images = images.len(), "a run filled its page");
        if !images.is_empty() {
            let (parts, run_dir, issue_id) = (parts.clone(), target.run.output_dir.clone(), issue.id.clone());
            tokio::spawn(async move { take_images(&parts, &issue_id, &run_dir, images).await });
        }
        let tally = tally(&design.contract, &data, srcs.len());
        Ok(if tally.is_empty() {
            format!("issue {} accepted", issue.id)
        } else {
            format!("issue {} accepted · {tally}", issue.id)
        })
    })
}

/// The run's issue: a new one, or a new revision of the one it filled before.
async fn store_fill(
    parts: &SurfacesParts,
    target: &Target,
    version: i64,
    data: &Value,
    images: &[IssueImage],
) -> Result<StoredIssue, Error> {
    let (run, surface_id, now, id) =
        (target.run.clone(), target.surface.id.clone(), parts.clock.now_ms(), parts.ids.surface_issue_id());
    let body = json!({ "data": data }).to_string();
    let images_json = serde_json::to_string(images).unwrap_or_else(|_| "[]".into());
    let status = if images.is_empty() { IssueStatus::Ready } else { IssueStatus::Preparing };
    parts
        .store
        .write(move |tx, out| {
            let earlier = tx.surface_issues().of_run(&run.run_id)?.into_iter().find(|i| i.surface_id == surface_id);
            let trial = run.kind == "trial";
            let issue = match earlier {
                Some(mut issue) => {
                    issue.rev += 1;
                    (issue.kind, issue.version, issue.status) = (IssueKind::Page, Some(version), status);
                    (issue.body_json, issue.images_json, issue.updated_at) = (body, images_json, now);
                    issue
                }
                None => StoredIssue {
                    id,
                    seq: if trial { None } else { Some(tx.surface_issues().next_seq(&surface_id)?) },
                    surface_id,
                    run_id: Some(run.run_id.clone()),
                    version: Some(version),
                    kind: IssueKind::Page,
                    status,
                    body_json: body,
                    rev: 1,
                    images_json,
                    trial,
                    kept: false,
                    created_at: now,
                    updated_at: now,
                },
            };
            tx.surface_issues().put(&issue)?;
            announce(out, &issue);
            Ok(issue)
        })
        .await
}

/// Fetches or reads each image once, then marks the issue ready with what
/// became of each.
async fn take_images(parts: &SurfacesParts, issue_id: &str, run_dir: &Path, mut images: Vec<IssueImage>) {
    let surface_id = match parts
        .store
        .read({
            let id = issue_id.to_owned();
            move |tx| Ok(tx.surface_issues().find(&id)?.map(|i| i.surface_id))
        })
        .await
    {
        Ok(Some(id)) => id,
        _ => return,
    };
    for image in &mut images {
        let Some(src) = source(&image.src, run_dir) else { continue };
        match parts.images.intake(&surface_id, src).await {
            Ok(stored) => image.hash = Some(stored.hash),
            Err(failure) => image.failed = Some(failure.reason().to_owned()),
        }
    }
    let failed = images.iter().filter(|i| i.failed.is_some()).count();
    let (id, now) = (issue_id.to_owned(), parts.clock.now_ms());
    let settled = parts
        .store
        .write(move |tx, out| {
            let Some(mut issue) = tx.surface_issues().find(&id)? else { return Ok(()) };
            if !issue.status.can_move_to(IssueStatus::Ready) {
                return Ok(());
            }
            (issue.status, issue.updated_at) = (IssueStatus::Ready, now);
            issue.images_json = serde_json::to_string(&images).unwrap_or_else(|_| "[]".into());
            tx.surface_issues().put(&issue)?;
            announce(out, &issue);
            Ok(())
        })
        .await;
    match settled {
        Ok(()) => tracing::info!(issue = %issue_id, failed, "a page issue's images settled"),
        Err(error) => tracing::warn!(issue = %issue_id, %error, "a page issue's images did not settle"),
    }
}

/// The run's issue as a fallback View of `data`; the surface is marked for a
/// redesign, and a second fallback in a row asks the user for one.
async fn fallback(parts: &SurfacesParts, target: &Target, data: &Value, problems: &[Problem]) -> Result<String, Error> {
    let contract = target.version.as_ref().map(|(_, design)| design.contract.clone());
    let view = fallback_view(&target.surface.title, contract.as_ref(), data);
    let paths: Vec<String> = problems.iter().map(|p| p.path.clone()).collect();
    let body = json!({ "view": view, "problems": paths }).to_string();
    let (run, surface, now, id) =
        (target.run.clone(), target.surface.clone(), parts.clock.now_ms(), parts.ids.surface_issue_id());
    let version = target.version.as_ref().map(|(n, _)| *n);
    let cards = parts.cards.clone();
    let issue = parts
        .store
        .write(move |tx, out| {
            let trial = run.kind == "trial";
            let before = tx.surface_issues().of_surface(&surface.id, None, 2)?;
            let issue = StoredIssue {
                id,
                seq: if trial { None } else { Some(tx.surface_issues().next_seq(&surface.id)?) },
                surface_id: surface.id.clone(),
                run_id: Some(run.run_id.clone()),
                version,
                kind: IssueKind::Fallback,
                status: IssueStatus::Ready,
                body_json: body,
                rev: 1,
                images_json: "[]".into(),
                trial,
                kept: false,
                created_at: now,
                updated_at: now,
            };
            tx.surface_issues().put(&issue)?;
            announce(out, &issue);
            let mut marked = surface.clone();
            marked.needs_redesign_json = Some(json!(paths).to_string());
            marked.updated_at = now;
            tx.surfaces().put(&marked)?;
            // The second fallback in a row asks once; later ones add nothing.
            let fell_back = |i: usize| before.get(i).is_some_and(|b| b.kind == IssueKind::Fallback && !b.trial);
            if !trial && fell_back(0) && !fell_back(1) {
                cards.redesign_in(tx, out, now, &run.routine_id, &run.run_id, &surface.id, &surface.title)?;
            }
            Ok(issue)
        })
        .await?;
    tracing::info!(surface = %issue.surface_id, issue = %issue.id, problems = problems.len(), "a page fell back to a view");
    Ok(format!(
        "issue {} is shown as a plain view: the page could not take this data. Hand in the result as it is; the page will be redesigned.",
        issue.id
    ))
}
