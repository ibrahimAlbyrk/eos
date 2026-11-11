//! The composition root: the only crate that knows every concrete type.
//!
//! ```text
//! let app = App::build(Options::new(home))?;   // data folder → adapters → modules → router
//! app.start().await?;                          // modules start, then get ready
//! let res = app.router().handle(request).await; // the bridge and the gateways call this
//! app.shutdown(Duration::from_secs(5)).await;  // modules stop, streams end, the writer drains
//! ```
//!
//! A feature is one line in [`modules`]. Whoever hands a request to the
//! router tags it with its caller first: [`Callers`] turns the ui-token a
//! local request carries into that tag.

mod agent;
mod announce;
mod app;
mod boot;
mod callers;
mod display;
mod host;
mod modules;

pub use app::{App, Options};
pub use callers::Callers;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The data folder cannot be used (created, read, written).
    #[error("data folder {}: {source}", path.display())]
    Home { path: std::path::PathBuf, source: std::io::Error },
    /// `state.db` did not open or migrate.
    #[error("database: {0}")]
    Database(#[from] eos_kit_sqlite::Error),
    /// A start-up step over the stored data failed.
    #[error("start-up: {0}")]
    Data(#[from] eos_core::Error),
    /// Two modules clash, a route has no access rule, or a module failed to start.
    #[error(transparent)]
    Runtime(#[from] eos_runtime::Error),
}
