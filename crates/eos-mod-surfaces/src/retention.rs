//! What a surface keeps (D32), checked each time a run gives it an issue:
//! the newest issues and any the user marked Keep, trial issues until a
//! week after the routine started, every version an issue still uses plus
//! the newest others, and only the images the kept issues show.

use eos_core::Error;
use eos_surface::{IssueAge, IssueStatus, VersionAge, issues_to_drop, versions_to_drop};

use crate::SurfacesParts;
use crate::page::images_of;

/// Every issue a surface holds is read; it holds at most the kept ones and
/// the week's trials.
const ALL: i64 = i64::MAX;

/// Drops what a surface no longer keeps; failures are only logged.
pub(crate) async fn sweep(parts: &SurfacesParts, surface_id: &str) {
    let kept = match trim(parts, surface_id).await {
        Ok(Some(kept)) => kept,
        // An issue still taking its images in: its images are not named yet.
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(surface = %surface_id, %error, "a surface's old issues were not cleared");
            return;
        }
    };
    if let Err(error) = parts.images.collect(surface_id, &kept).await {
        tracing::warn!(surface = %surface_id, %error, "a surface's old images were not cleared");
    }
}

/// Drops old issues and versions in one write; the image hashes still
/// shown, none while an issue is still taking its images in.
async fn trim(parts: &SurfacesParts, surface_id: &str) -> Result<Option<Vec<String>>, Error> {
    let (id, now) = (surface_id.to_owned(), parts.clock.now_ms());
    let (issues, versions, kept) = parts
        .store
        .write(move |tx, _| {
            let Some(surface) = tx.surfaces().find(&id)? else { return Ok((0, 0, None)) };
            let started = tx.routines().find(&surface.routine_id)?.and_then(|r| r.started_at);
            let all = tx.surface_issues().of_surface(&id, None, ALL)?;
            let ages: Vec<IssueAge> = all
                .iter()
                .map(|i| IssueAge { id: i.id.clone(), created_at: i.created_at, kept: i.kept, trial: i.trial })
                .collect();
            let dropped = issues_to_drop(&ages, started, now);
            tx.surface_issues().delete(&dropped)?;
            let left: Vec<_> = all.iter().filter(|i| !dropped.contains(&i.id)).collect();
            let in_use: Vec<i64> = left.iter().filter_map(|i| i.version).collect();
            let ages: Vec<VersionAge> = tx
                .surface_versions()
                .of_surface(&id)?
                .into_iter()
                .map(|v| VersionAge { version: v.version, status: v.status })
                .collect();
            let old = versions_to_drop(&ages, &in_use);
            tx.surface_versions().delete(&id, &old)?;
            let preparing = left.iter().any(|i| i.status == IssueStatus::Preparing);
            let kept =
                (!preparing).then(|| left.iter().flat_map(|i| images_of(i)).filter_map(|image| image.hash).collect());
            Ok((dropped.len(), old.len(), kept))
        })
        .await?;
    if issues + versions > 0 {
        tracing::info!(surface = %surface_id, issues, versions, "a surface's old issues and versions were cleared");
    }
    Ok(kept)
}
