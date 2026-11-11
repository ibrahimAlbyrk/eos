#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The program could not be started (not found, not executable, bad folder).
    #[error("could not start {program}: {source}")]
    Spawn { program: String, source: std::io::Error },
    /// The command printed more than its cap allows and was ended ([`Overflow::Fail`](crate::Overflow)).
    #[error("the command printed more than {limit} bytes")]
    OutputTooLarge { limit: usize },
    /// The task watching the child went away before it reported an exit (the runtime is shutting down).
    #[error("the command's result was lost")]
    Lost,
}
