//! Every feature of the app: one line each.

use std::sync::Arc;

use eos_core::store::Store;
use eos_core::{Clock, Ids};
use eos_platform::DataPaths;
use eos_runtime::Kernel;
use eos_runtime::module::Module;

/// What features are built from. A module's constructor takes the parts it
/// uses (never this struct: feature crates cannot see `eos-app`).
pub(crate) struct Context {
    pub(crate) kernel: Kernel,
    pub(crate) paths: DataPaths,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) store: Arc<dyn Store>,
}

/// The modules, in start order (stop order is the reverse). A feature crate
/// adds its line here, in alphabetical order; nothing else in the app changes.
pub(crate) fn all(cx: &Context) -> Vec<Arc<dyn Module>> {
    let _ = (&cx.kernel, &cx.paths, &cx.clock, &cx.ids, &cx.store);
    vec![]
}
