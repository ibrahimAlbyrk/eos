/// What can go wrong between a caller and the database.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A migration's SQL failed; nothing of it was kept.
    #[error("migration {id} failed: {source}")]
    Migration { id: String, source: rusqlite::Error },
    /// The writer could not start a transaction (another process holds the file).
    #[error("the database could not start a write: {0}")]
    BeginFailed(String),
    /// The transaction this write was folded into did not commit: nothing of it was saved.
    #[error("the write was not saved: its transaction failed to commit")]
    CommitFailed,
    /// The queue is at its bound. `write`/`read` wait instead; only the non-blocking calls report this.
    #[error("the database queue is full")]
    QueueFull,
    #[error("the database is closed")]
    Closed,
    /// The job panicked; its changes were undone and the thread carries on.
    #[error("a database job panicked: {0}")]
    JobPanicked(String),
    #[error("could not start a database thread: {0}")]
    Spawn(std::io::Error),
}
