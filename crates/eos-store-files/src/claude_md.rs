//! The configured memory sources (CLAUDE.md, AGENTS.md-style files) read from
//! disk: per source, the user-level files, then every project file name from
//! the repository root down to the session's folder.

use std::fs;
use std::path::{Path, PathBuf};

use eos_core::prompt::{MemoryDoc, MemoryLevel, MemoryProvider, MemoryScope, MemorySnapshot};
use eos_domain::memory_sources::ResolvedMemorySource;

/// Reads the sources it was built with; it knows nothing of the config they
/// came from.
#[derive(Debug)]
pub struct FileMemoryProvider {
    sources: Vec<ResolvedMemorySource>,
    /// What `~` in a source's user path stands for.
    user_home: PathBuf,
}

impl FileMemoryProvider {
    pub fn new(sources: Vec<ResolvedMemorySource>, user_home: impl Into<PathBuf>) -> Self {
        Self { sources, user_home: user_home.into() }
    }

    fn expand(&self, path: &str) -> PathBuf {
        match path.strip_prefix('~') {
            Some("") => self.user_home.clone(),
            Some(rest) if rest.starts_with('/') => self.user_home.join(rest.trim_start_matches('/')),
            _ => PathBuf::from(path),
        }
    }
}

impl MemoryProvider for FileMemoryProvider {
    fn load(&self, scope: MemoryScope<'_>) -> MemorySnapshot {
        let dirs = project_dirs(scope.cwd, scope.repo_root);
        let mut docs = Vec::new();
        for source in &self.sources {
            let user = source.user_paths.iter().map(|path| (self.expand(path), MemoryLevel::User));
            let project = dirs.iter().flat_map(|dir| {
                source.project_filenames.iter().map(move |name| (dir.join(name), MemoryLevel::Project))
            });
            for (path, level) in user.chain(project) {
                // Missing, unreadable or blank: skipped.
                let Ok(content) = fs::read_to_string(&path) else { continue };
                if eos_domain::text::js_trim(&content).is_empty() {
                    continue;
                }
                docs.push(MemoryDoc {
                    source_id: source.id.clone(),
                    source_label: source.label.clone(),
                    native_for: source.assume_native_for.clone(),
                    path,
                    level,
                    content,
                });
            }
        }
        MemorySnapshot { docs }
    }
}

/// From the boundary down to `cwd`. The boundary is the first of: a folder
/// with a `.git` entry (a worktree's `.git` file counts), `repo_root`, the
/// filesystem root.
fn project_dirs(cwd: &Path, repo_root: Option<&Path>) -> Vec<PathBuf> {
    let mut chain = Vec::new();
    let mut dir = cwd;
    loop {
        chain.push(dir.to_owned());
        if dir.join(".git").exists() || repo_root == Some(dir) {
            break;
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => break,
        }
    }
    chain.reverse();
    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, user: &[&str], names: &[&str], native: &[&str]) -> ResolvedMemorySource {
        ResolvedMemorySource {
            id: id.to_owned(),
            label: format!("{id} label"),
            user_paths: user.iter().map(|s| (*s).to_owned()).collect(),
            project_filenames: names.iter().map(|s| (*s).to_owned()).collect(),
            priority: 0.0,
            assume_native_for: native.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, content).expect("write");
    }

    #[test]
    fn reads_user_files_then_project_files_from_the_repository_root_down() {
        let temp = tempfile::tempdir().expect("dir");
        let (home, repo) = (temp.path().join("home"), temp.path().join("outer/repo"));
        write(&home.join(".claude/CLAUDE.md"), "# user rules\n");
        write(&temp.path().join("outer/CLAUDE.md"), "above the repository: never read\n");
        write(&repo.join(".git/HEAD"), "ref");
        write(&repo.join("CLAUDE.md"), "repo rules\n");
        write(&repo.join("app/CLAUDE.md"), "  \n");
        write(&repo.join("app/ui/CLAUDE.md"), "ui rules\n");
        write(&repo.join("app/ui/AGENTS.md"), "agents here\n");

        let provider = FileMemoryProvider::new(
            vec![
                source("agents", &[], &["AGENTS.md"], &[]),
                source("claude", &["~/.claude/CLAUDE.md", "~/missing.md"], &["CLAUDE.md"], &["claude"]),
            ],
            &home,
        );
        let cwd = repo.join("app/ui");
        let snapshot = provider.load(MemoryScope { cwd: &cwd, repo_root: None });
        let seen: Vec<(&str, MemoryLevel, &str)> =
            snapshot.docs.iter().map(|d| (d.source_id.as_str(), d.level, d.content.as_str())).collect();
        assert_eq!(
            seen,
            [
                ("agents", MemoryLevel::Project, "agents here\n"),
                ("claude", MemoryLevel::User, "# user rules\n"),
                ("claude", MemoryLevel::Project, "repo rules\n"),
                ("claude", MemoryLevel::Project, "ui rules\n"),
            ]
        );
        assert_eq!(snapshot.docs[1].path, home.join(".claude/CLAUDE.md"));
        assert_eq!(snapshot.docs[1].source_label, "claude label");
        assert_eq!(snapshot.docs[1].native_for, ["claude"]);
    }

    #[test]
    fn the_walk_up_stops_at_the_given_root() {
        let temp = tempfile::tempdir().expect("dir");
        let top = temp.path().join("top");
        write(&top.join("CLAUDE.md"), "top\n");
        write(&top.join("mid/CLAUDE.md"), "mid\n");
        write(&top.join("mid/low/CLAUDE.md"), "low\n");
        let provider = FileMemoryProvider::new(vec![source("claude", &[], &["CLAUDE.md"], &[])], temp.path());
        let (cwd, mid) = (top.join("mid/low"), top.join("mid"));
        let bounded = provider.load(MemoryScope { cwd: &cwd, repo_root: Some(&mid) });
        assert_eq!(bounded.docs.iter().map(|d| d.content.as_str()).collect::<Vec<_>>(), ["mid\n", "low\n"]);
        let only = provider.load(MemoryScope { cwd: &cwd, repo_root: Some(&cwd) });
        assert_eq!(only.docs.iter().map(|d| d.content.as_str()).collect::<Vec<_>>(), ["low\n"]);
    }

    #[test]
    fn a_tilde_is_the_users_home() {
        let provider = FileMemoryProvider::new(Vec::new(), "/home/me");
        assert_eq!(provider.expand("~"), Path::new("/home/me"));
        assert_eq!(provider.expand("~/.claude/CLAUDE.md"), Path::new("/home/me/.claude/CLAUDE.md"));
        assert_eq!(provider.expand("~other/x"), Path::new("~other/x"));
        assert_eq!(provider.expand("/abs/AGENTS.md"), Path::new("/abs/AGENTS.md"));
    }
}
