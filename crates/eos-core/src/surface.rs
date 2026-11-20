//! What routines ask of surfaces: the designed view, page or app a routine
//! makes follows the routine through its life (05 §4).

use crate::{BoxFuture, Error};

/// The surface of a routine whose blueprint makes a view, a page or an app.
/// Each call comes after the routine's own write committed; a failure here
/// never undoes it.
pub trait SurfaceAuthoring: Send + Sync {
    /// A routine was created: its surface starts from `version_id`'s
    /// blueprint, which makes `makes`.
    fn create_for_routine<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
        makes: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine started: the surface's candidate becomes its first kept
    /// version.
    fn keep<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine was archived or deleted.
    fn archive_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine came back from the archive or from Recently deleted.
    fn restore_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}
