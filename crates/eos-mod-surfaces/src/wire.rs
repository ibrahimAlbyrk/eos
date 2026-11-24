//! Stored rows as the wire carries them.

use eos_contracts::{SurfaceIssueRow, SurfaceRow, SurfaceVersion, SurfaceVersionMeta};
use eos_core::store::{StoredIssue, StoredSurface, StoredSurfaceVersion};
use serde_json::Value;

fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

pub(crate) fn surface_row(s: &StoredSurface) -> SurfaceRow {
    SurfaceRow {
        id: s.id.clone(),
        routine_id: s.routine_id.clone(),
        level: s.level.as_str().to_owned(),
        place: s.place.as_str().to_owned(),
        role: s.role.as_str().to_owned(),
        title: s.title.clone(),
        current_version: s.current_version,
        candidate_version: s.candidate_version,
        needs_redesign: s.needs_redesign_json.as_deref().map(json),
        archived_at: s.archived_at,
        created_at: s.created_at,
        updated_at: s.updated_at,
    }
}

pub(crate) fn version_meta(v: &StoredSurfaceVersion) -> SurfaceVersionMeta {
    SurfaceVersionMeta {
        version: v.version,
        status: v.status.as_str().to_owned(),
        base_version: v.base_version,
        made_by: v.made_by.as_str().to_owned(),
        run_id: v.run_id.clone(),
        note: v.note.clone(),
        body_bytes: v.body_bytes,
        created_at: v.created_at,
        kept_at: v.kept_at,
    }
}

/// `access_line` is an App's, which Eos writes from its manifest.
pub(crate) fn version(v: &StoredSurfaceVersion, access_line: Option<String>) -> SurfaceVersion {
    SurfaceVersion { meta: version_meta(v), body: json(&v.body_json), checks: json(&v.checks_json), access_line }
}

pub(crate) fn issue_row(i: &StoredIssue) -> SurfaceIssueRow {
    SurfaceIssueRow {
        id: i.id.clone(),
        surface_id: i.surface_id.clone(),
        seq: i.seq,
        run_id: i.run_id.clone(),
        version: i.version,
        kind: i.kind.as_str().to_owned(),
        status: i.status.as_str().to_owned(),
        rev: i.rev,
        trial: i.trial,
        kept: i.kept,
        created_at: i.created_at,
        updated_at: i.updated_at,
    }
}
