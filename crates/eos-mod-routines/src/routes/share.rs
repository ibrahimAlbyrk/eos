//! A routine as one file (01 §6): `GET /api/routines/{id}/export` answers
//! it (its versions and settings, no runs), the same file a final delete
//! leaves in the trash with its runs beside; `POST /api/routines/import`
//! makes a draft routine of such a file, from the version it ran from.
//! Nothing of the routine's recipients is confirmed by an import: the user
//! confirms them again before anything goes out.

use std::sync::Arc;

use eos_contracts::VersionStatus;
use eos_core::Error;
use eos_core::store::Tx;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

use super::{gone, param, with_blueprint};
use crate::engine::{self, Engine, Saved};

/// The format of the file.
const FORMAT: i64 = 1;
/// The origin of a routine made from a file.
const IMPORT: &str = "import";

/// The routine as its file holds it, without runs.
pub(crate) fn export_of(tx: &dyn Tx, routine_id: &str) -> Result<Value, Error> {
    let routine = tx.routines().find(routine_id)?.ok_or_else(|| Error::not_found("routine", routine_id))?;
    let stored = tx.routine_versions().list(routine_id)?;
    let versions =
        stored.iter().enumerate().map(|(at, version)| with_blueprint(at, version)).collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "format": FORMAT,
        "routine": {
            "id": routine.id,
            "name": routine.name,
            "kind": routine.kind,
            "headVersionId": routine.head_version_id,
            "createdAt": routine.created_at,
            "deletedAt": routine.deleted_at,
        },
        "versions": versions,
    }))
}

/// The blueprint a file's routine ran from: its head, else its newest kept
/// version, else its newest.
fn blueprint_of(file: &Value) -> Result<Value, ApiError> {
    if file["format"].as_i64() != Some(FORMAT) {
        return Err(ApiError::Validation("not a routine file this Eos can read".into()));
    }
    let versions = file["versions"].as_array().filter(|versions| !versions.is_empty());
    let versions = versions.ok_or_else(|| ApiError::Validation("the file holds no version".into()))?;
    let head = file["routine"]["headVersionId"].as_str();
    let kept = serde_json::to_value(VersionStatus::Kept).unwrap_or_default();
    let chosen = versions
        .iter()
        .find(|version| head.is_some() && version["id"].as_str() == head)
        .or_else(|| versions.iter().rev().find(|version| version["status"] == kept))
        .or_else(|| versions.last());
    chosen.map(|version| version["blueprint"].clone()).ok_or_else(|| ApiError::Validation("no version".into()))
}

pub(super) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let exporting = engine.clone();
    let export = RouteDef::get("/api/routines/{id}/export", move |req: Request| {
        let engine = exporting.clone();
        async move {
            let (id, now) = (param(&req, "id"), engine.clock.now_ms());
            let file = engine
                .store
                .read(move |tx| {
                    let shown = tx
                        .routines()
                        .find(&id)?
                        .filter(|routine| !gone(routine, now) && routine.origin != super::BUILTIN);
                    shown.ok_or_else(|| Error::not_found("routine", &id))?;
                    export_of(tx, &id)
                })
                .await?;
            Ok(Response::json(200, &file))
        }
    });
    let importing = engine.clone();
    let import = RouteDef::post("/api/routines/import", move |req: Request| {
        let engine = importing.clone();
        async move {
            let file: Value = req.parse()?;
            let blueprint = blueprint_of(&file)?;
            let note = Some("Imported from a file".to_owned());
            Ok(match engine::create(&engine, blueprint, note, IMPORT).await? {
                Saved::Done(saved) => Response::json(201, &saved),
                Saved::Refused(issues) => Response::json(
                    400,
                    &eos_contracts::BlueprintRefused { error: "the blueprint does not meet its rules".into(), issues },
                ),
            })
        }
    });
    vec![export.access(Access::ui_token()), import.access(Access::ui_token())]
}
