//! A project folder ⇄ the key it travels under between computers.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_core::git::{GitInfo, ProjectKeys};
use eos_core::{BoxFuture, Clock};
use eos_domain::git::project_key::{git_key, normalize_remote, path_key, split_git_key};
use eos_kit_fs::{WriteOptions, atomic_write};
use serde_json::{Map, Value};

/// How long a folder's repository and remote are remembered.
const CACHE_TTL_MS: i64 = 10 * 60_000;
/// Folders remembered; the oldest goes first.
const MAX_CACHED: usize = 512;

#[derive(Debug, Clone)]
struct Repo {
    root: PathBuf,
    remote: String,
}

struct Seen {
    path: String,
    at: i64,
    repo: Option<Repo>,
}

/// The folders this computer knows (projects, recent folders, agents'
/// folders): where a key is looked for.
pub type KnownFolders = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

/// The `ProjectKeys` port over git remotes.
///
/// A key this computer cannot place yet (the repository is not cloned here)
/// keeps the sender's path, and that path is remembered against the key in
/// `learned_path` — so editing the record here does not send the key back as
/// a bare path.
pub struct GitProjectKeys {
    git: Arc<dyn GitInfo>,
    candidates: KnownFolders,
    learned_path: PathBuf,
    clock: Arc<dyn Clock>,
    seen: Mutex<Vec<Seen>>,
    /// Path → key, in the order learned.
    learned: Mutex<Map<String, Value>>,
}

impl std::fmt::Debug for GitProjectKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitProjectKeys").field("learned_path", &self.learned_path).finish_non_exhaustive()
    }
}

fn read_learned(path: &Path) -> Map<String, Value> {
    match fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()) {
        Some(Value::Object(map)) => map.into_iter().filter(|(_, key)| key.is_string()).collect(),
        _ => Map::new(),
    }
}

fn real_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}

impl GitProjectKeys {
    /// `learned_path` is `<data folder>/sync/project-keys.json`.
    pub fn new(
        git: Arc<dyn GitInfo>,
        candidates: KnownFolders,
        learned_path: impl Into<PathBuf>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let learned_path = learned_path.into();
        let learned = Mutex::new(read_learned(&learned_path));
        Self { git, candidates, learned_path, clock, seen: Mutex::new(Vec::new()), learned }
    }

    /// The repository a folder is in and its `origin`, when it has both.
    async fn repo_of(&self, path: &str) -> Option<Repo> {
        let now = self.clock.now_ms();
        {
            let seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(known) = seen.iter().find(|s| s.path == path && now - s.at < CACHE_TTL_MS) {
                return known.repo.clone();
            }
        }
        let repo = async {
            if !Path::new(path).exists() {
                return None;
            }
            let dirs = self.git.git_dirs(Path::new(path)).await?;
            let remote = normalize_remote(&self.git.remote_url(&dirs.toplevel).await?)?;
            Some(Repo { root: dirs.toplevel, remote })
        }
        .await;
        let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        seen.retain(|s| s.path != path);
        if seen.len() >= MAX_CACHED {
            seen.remove(0);
        }
        seen.push(Seen { path: path.to_owned(), at: now, repo: repo.clone() });
        repo
    }

    async fn find(&self, key: &str, folders: Vec<String>) -> Option<String> {
        let (remote, sub) = split_git_key(key)?;
        let mut tried: Vec<&String> = Vec::new();
        for folder in &folders {
            if tried.contains(&folder) {
                continue;
            }
            tried.push(folder);
            if let Some(repo) = self.repo_of(folder).await
                && repo.remote == remote
            {
                let found = match sub.filter(|sub| !sub.is_empty()) {
                    Some(sub) => repo.root.join(sub),
                    None => repo.root,
                };
                return Some(found.to_string_lossy().into_owned());
            }
        }
        None
    }

    fn learn(&self, path: &str, key: &str) {
        let mut learned = self.learned.lock().unwrap_or_else(|p| p.into_inner());
        if learned.get(path).and_then(Value::as_str) == Some(key) {
            return;
        }
        learned.insert(path.to_owned(), Value::String(key.to_owned()));
        // A failed save only costs remembering this key until the next one is learned.
        if let Ok(json) = serde_json::to_vec_pretty(&*learned) {
            let _ = atomic_write(&self.learned_path, &json, &WriteOptions::default());
        }
    }
}

impl ProjectKeys for GitProjectKeys {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async move {
            let Some(repo) = self.repo_of(path).await else {
                let learned = self.learned.lock().unwrap_or_else(|p| p.into_inner());
                return learned.get(path).and_then(Value::as_str).map_or_else(|| path_key(path), str::to_owned);
            };
            let (root, folder) = (real_path(&repo.root), real_path(Path::new(path)));
            let sub = folder.strip_prefix(&root).map(|sub| sub.to_string_lossy().into_owned()).unwrap_or_default();
            git_key(&repo.remote, &sub)
        })
    }

    fn to_path<'a>(&'a self, key: &'a str, hint: &'a str) -> BoxFuture<'a, String> {
        Box::pin(async move {
            if let Some(path) = key.strip_prefix("path:") {
                return path.to_owned();
            }
            let mut folders = vec![hint.to_owned()];
            folders.extend((self.candidates)());
            if let Some(found) = self.find(key, folders).await {
                return found;
            }
            self.learn(hint, key);
            hint.to_owned()
        })
    }

    fn find_path<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.find(key, (self.candidates)()).await })
    }
}
