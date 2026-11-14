use crate::BoxFuture;

/// How a project folder travels between computers: as its repository's
/// remote (`git:github.com/owner/repo`, plus `#sub/dir`), or as `path:<abs>`
/// when it has none.
pub trait ProjectKeys: Send + Sync {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String>;
    /// This computer's folder for `key`; `hint` (the sender's path) when the
    /// repository is not here, remembered against the key.
    fn to_path<'a>(&'a self, key: &'a str, hint: &'a str) -> BoxFuture<'a, String>;
    /// This computer's checkout for a `git:` key, or `None`: never a guess.
    fn find_path<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Option<String>>;
}
