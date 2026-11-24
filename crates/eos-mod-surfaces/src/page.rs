//! A page issue as the renderers take it: the design of the version it was
//! made with (or one asked for), its data, what became of its images, Eos's
//! own `issue.*` names in the reader's day, and the reading settings. Every
//! mode is drawn from this; secrets are masked by `redact`'s shapes.

use std::collections::HashMap;
use std::sync::Arc;

use eos_core::Error;
use eos_core::store::{StoredIssue, StoredSurface};
use eos_domain::redact::looks_secret;
use eos_domain::time::{iso_from_ms, wall_clock};
use eos_runtime::http::ApiError;
use eos_surface::render::{Comfort, ImageState, IssueFacts, RenderInput};
use eos_surface::{IssueKind, PageDesign};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::SurfacesParts;

/// What became of one image of an issue, as `surface_issues.images` keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueImage {
    pub(crate) src: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) failed: Option<String>,
}

pub(crate) fn images_of(issue: &StoredIssue) -> Vec<IssueImage> {
    serde_json::from_str(&issue.images_json).unwrap_or_default()
}

/// Everything one drawing of an issue needs.
pub(crate) struct Drawn {
    pub(crate) surface: StoredSurface,
    pub(crate) issue: StoredIssue,
    pub(crate) design: PageDesign,
    pub(crate) data: Value,
    pub(crate) facts: IssueFacts,
    pub(crate) images: HashMap<String, ImageState>,
    pub(crate) offset: i32,
    pub(crate) comfort: Comfort,
}

impl Drawn {
    pub(crate) fn input<'a>(
        &'a self,
        image_src: &'a dyn Fn(&str) -> Option<String>,
        live: &'a HashMap<String, Value>,
    ) -> RenderInput<'a> {
        RenderInput {
            design: &self.design,
            data: &self.data,
            issue: &self.facts,
            images: &self.images,
            image_src,
            live,
            is_secret: &looks_secret,
            offset: self.offset,
            lang: "en",
            title: &self.surface.title,
            comfort: self.comfort,
        }
    }

    /// The hashes of the images the issue holds.
    pub(crate) fn hashes(&self) -> Vec<String> {
        self.images
            .values()
            .filter_map(|state| match state {
                ImageState::Ready { hash } => Some(hash.clone()),
                _ => None,
            })
            .collect()
    }
}

/// A page issue of surface `surface_id`, drawn with its own version or
/// `version` when one is asked for.
pub(crate) async fn load(
    parts: &Arc<SurfacesParts>,
    surface_id: &str,
    issue_id: &str,
    version: Option<i64>,
) -> Result<Drawn, ApiError> {
    let (sid, iid) = (surface_id.to_owned(), issue_id.to_owned());
    let (surface, issue, body) = parts
        .store
        .read(move |tx| {
            let surface = tx.surfaces().find(&sid)?.ok_or_else(|| Error::not_found("surface", &sid))?;
            let issue = tx.surface_issues().find(&iid)?.filter(|i| i.surface_id == sid && i.kind == IssueKind::Page);
            let issue = issue.ok_or_else(|| Error::not_found("issue", &iid))?;
            let number = version.or(issue.version).ok_or_else(|| Error::not_found("version", &iid))?;
            let found = tx.surface_versions().find(&sid, number)?;
            let found = found.ok_or_else(|| Error::not_found("version", number.to_string()))?;
            Ok((surface, issue, found.body_json))
        })
        .await?;
    let body: Value = serde_json::from_str(&body).map_err(|e| Error::Storage(format!("a stored design: {e}")))?;
    let design =
        PageDesign::from_body(&body).map_err(|_| ApiError::Conflict("this design no longer reads as a page".into()))?;
    let stored: Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
    let images = images_of(&issue)
        .into_iter()
        .map(|image| {
            let state = match (image.hash, image.failed) {
                (Some(hash), _) => ImageState::Ready { hash },
                (None, Some(reason)) => ImageState::Failed { reason },
                (None, None) => ImageState::Preparing,
            };
            (image.src, state)
        })
        .collect();
    let offset = parts.zone.offset_minutes_at(issue.created_at);
    let reading = crate::settings::reading(parts).await?;
    let facts = IssueFacts {
        id: issue.id.clone(),
        seq: issue.seq,
        date: local_date(issue.created_at, offset),
        reader: reader_name(parts),
    };
    Ok(Drawn {
        surface,
        data: stored.get("data").cloned().unwrap_or_default(),
        issue,
        design,
        facts,
        images,
        offset,
        comfort: Comfort { text_scale: reading.text_scale, more_contrast: reading.contrast == "more" },
    })
}

/// `YYYY-MM-DD` of `at` where the reader is.
pub(crate) fn local_date(at: i64, offset: i32) -> String {
    iso_from_ms(wall_clock(at, &|_| offset)).chars().take(10).collect()
}

/// The reader's first name, as the profile calls them.
fn reader_name(parts: &SurfacesParts) -> String {
    let Some(profile) = parts.profile.get() else { return String::new() };
    let identity = &profile.identity;
    let name = if identity.call_name.trim().is_empty() { &identity.full_name } else { &identity.call_name };
    name.split_whitespace().next().unwrap_or_default().to_owned()
}
