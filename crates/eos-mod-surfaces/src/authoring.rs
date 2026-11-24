//! A routine's surface follows the routine (05 G27): made when a routine
//! whose blueprint makes a view, a page or an app is created, its candidate
//! kept when the routine starts, archived (and unpinned) and brought back
//! with it, and removed when it leaves for good: its folder under
//! `surfaces/` to the trash, then its rows. Each change is one write,
//! announced on `surfaces:change`. Built before the
//! routines feature, which holds it.

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::SurfacesChange;
use eos_core::os::FileSystem;
use eos_core::store::{Outbox, Store, StoredSurface, Tx};
use eos_core::surface::SurfaceAuthoring;
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_surface::{Level, Place, Role, VersionStatus};

use crate::SURFACES_CHANGE;

pub struct SurfaceAuthor {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    /// The trash, for a removed surface's folder.
    trash: Arc<dyn FileSystem>,
    /// `surfaces/`, one folder per surface.
    root: PathBuf,
}

impl std::fmt::Debug for SurfaceAuthor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurfaceAuthor").finish_non_exhaustive()
    }
}

fn changed(out: &mut Outbox, surface: &StoredSurface, what: &str) {
    let change =
        SurfacesChange { surface_id: surface.id.clone(), routine_id: surface.routine_id.clone(), what: what.into() };
    out.push(SURFACES_CHANGE.name(), &change);
}

/// Where a surface of each level shows, and what it is for.
fn shape_of(makes: &str) -> Option<(Level, Place, Role)> {
    match makes {
        "view" => Some((Level::View, Place::NeedsYou, Role::Result)),
        "page" => Some((Level::Page, Place::RoutinePage, Role::Page)),
        "app" => Some((Level::App, Place::RoutinePage, Role::App)),
        _ => None,
    }
}

impl SurfaceAuthor {
    pub fn new(
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        trash: Arc<dyn FileSystem>,
        root: PathBuf,
    ) -> Self {
        Self { store, clock, ids, trash, root }
    }

    /// Changes every surface of the routine that `pick` takes, in one write.
    async fn each(
        &self,
        routine_id: &str,
        what: &'static str,
        change: impl Fn(&dyn Tx, &mut Outbox, &mut StoredSurface, i64) -> Result<bool, Error> + Send + 'static,
    ) -> Result<(), Error> {
        let (id, now) = (routine_id.to_owned(), self.clock.now_ms());
        self.store
            .write(move |tx, out| {
                for mut surface in tx.surfaces().of_routine(&id)? {
                    if change(tx, out, &mut surface, now)? {
                        surface.updated_at = now;
                        tx.surfaces().put(&surface)?;
                        changed(out, &surface, what);
                    }
                }
                Ok(())
            })
            .await
    }
}

impl SurfaceAuthoring for SurfaceAuthor {
    fn create_for_routine<'a>(
        &'a self,
        routine_id: &'a str,
        _version_id: &'a str,
        makes: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let Some((level, place, role)) = shape_of(makes) else { return Ok(()) };
            let (id, now, surface_id) = (routine_id.to_owned(), self.clock.now_ms(), self.ids.surface_id());
            self.store
                .write(move |tx, out| {
                    if tx.surfaces().of_routine(&id)?.iter().any(|s| s.level == level) {
                        return Ok(());
                    }
                    let title = tx.routines().find(&id)?.map(|r| r.name).unwrap_or_default();
                    let surface = StoredSurface {
                        id: surface_id,
                        routine_id: id,
                        level,
                        place,
                        role,
                        title,
                        current_version: None,
                        candidate_version: None,
                        needs_redesign_json: None,
                        archived_at: None,
                        created_at: now,
                        updated_at: now,
                    };
                    tx.surfaces().put(&surface)?;
                    changed(out, &surface, "created");
                    tracing::info!(surface = %surface.id, level = level.as_str(), "a routine's surface was made");
                    Ok(())
                })
                .await
        })
    }

    fn keep<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.each(routine_id, "version", |tx, _, surface, now| {
            let Some(candidate) = surface.candidate_version else { return Ok(false) };
            let Some(mut version) = tx.surface_versions().find(&surface.id, candidate)? else { return Ok(false) };
            if !version.status.can_move_to(VersionStatus::Kept) {
                return Ok(false);
            }
            version.status = VersionStatus::Kept;
            version.kept_at = Some(now);
            tx.surface_versions().put(&version)?;
            surface.current_version = Some(candidate);
            surface.candidate_version = None;
            Ok(true)
        }))
    }

    fn archive_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.each(routine_id, "archived", |tx, out, surface, now| {
            crate::pins::unpin(tx, out, &surface.id)?;
            let fresh = surface.archived_at.is_none();
            surface.archived_at = surface.archived_at.or(Some(now));
            Ok(fresh)
        }))
    }

    fn restore_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.each(routine_id, "restored", |_, _, surface, _| Ok(surface.archived_at.take().is_some())))
    }

    fn remove_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let id = routine_id.to_owned();
            let surfaces = self.store.read(move |tx| tx.surfaces().of_routine(&id)).await?;
            for surface in surfaces {
                let dir = self.root.join(&surface.id);
                if self.trash.exists(&dir).await {
                    self.trash.trash(&dir).await?;
                }
                let gone = surface.clone();
                self.store
                    .write(move |tx, out| {
                        crate::pins::unpin(tx, out, &gone.id)?;
                        tx.surfaces().remove(&gone.id)?;
                        changed(out, &gone, "removed");
                        Ok(())
                    })
                    .await?;
                tracing::info!(surface = %surface.id, "a routine's surface left for good");
            }
            Ok(())
        })
    }
}
