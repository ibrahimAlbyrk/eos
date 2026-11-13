//! Where HEAD and the branches stand: the answers of nine git commands
//! (`branch --show-current`, `branch --format`, `rev-parse --abbrev-ref
//! HEAD`, `rev-parse … @{u}`, `rev-list --left-right --count @{u}...HEAD`,
//! `remote`, `remote get-url origin`, `stash list`, and `diff.relative` from
//! the configuration), read in process with gix.
//!
//! git's own rules are followed where gix has none: short names are made as
//! `refs_shorten_unambiguous_ref` makes them, an upstream as `branch_get_upstream`
//! finds it. Whatever gix could read differently from git — reftable, a sort
//! order or URL rewriting in the configuration, shallow history, replaced
//! objects, a short name that could mean two refs, an untrusted folder, git
//! settings from the environment — is answered by the git commands instead.

use std::path::Path;
use std::sync::OnceLock;

use eos_core::git::{GitDirs, GitInfo, SyncStatus};
use eos_domain::git::push_plan::PushState;
use gix::bstr::ByteSlice;

use crate::Git;
use crate::records::web_url;

/// What the nine commands answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Refs {
    pub(super) current_branch: Option<String>,
    pub(super) branches: Vec<String>,
    pub(super) remotes: Vec<String>,
    pub(super) remote_url: Option<String>,
    pub(super) sync: Option<SyncStatus>,
    pub(super) push: PushState,
    pub(super) stash: u32,
    /// `diff.relative`: `git diff` run in a subfolder shows only that folder.
    pub(super) diff_relative: bool,
}

/// Something gix may read differently from git; the reason is logged.
#[derive(Debug)]
pub(super) struct Unsupported(pub(super) &'static str);

/// What gix read. `branches` is `None` on a detached HEAD: git lists a
/// description of it first (`(HEAD detached at 1a2b3c4)`), which only git makes.
pub(super) struct Read {
    pub(super) refs: Refs,
    pub(super) detached: bool,
}

/// git's rules for the name a ref goes by (`refs.c`, `ref_rev_parse_rules`):
/// prefix and suffix around the short name.
const RULES: [(&str, &str); 6] = [
    ("", ""),
    ("refs/", ""),
    ("refs/tags/", ""),
    ("refs/heads/", ""),
    ("refs/remotes/", ""),
    ("refs/remotes/", "/HEAD"),
];

/// Environment variables with which git reads another repository, other
/// refs or other settings than the folder's own.
const GIT_ENVIRONMENT: [&str; 15] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_GRAFT_FILE",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

fn environment_steers_git() -> bool {
    static STEERS: OnceLock<bool> = OnceLock::new();
    *STEERS.get_or_init(|| GIT_ENVIRONMENT.iter().any(|name| std::env::var_os(name).is_some()))
}

fn unsupported<E>(why: &'static str) -> impl FnOnce(E) -> Unsupported {
    move |_| Unsupported(why)
}

fn text(bytes: &[u8]) -> Result<String, Unsupported> {
    bytes.to_str().map(str::to_owned).map_err(unsupported("a name is not UTF-8"))
}

/// Opens the repository of the working tree at `top` for reading refs.
pub(super) fn open(top: &Path) -> Result<gix::ThreadSafeRepository, Unsupported> {
    if environment_steers_git() {
        return Err(Unsupported("git settings come from the environment"));
    }
    gix::ThreadSafeRepository::open(top).map_err(unsupported("gix could not open the repository"))
}

struct Reader<'a> {
    repo: &'a gix::Repository,
    dirs: &'a GitDirs,
    /// `core.warnAmbiguousRefs`: a short name must not match any other rule.
    strict: bool,
}

impl Reader<'_> {
    /// Whether the ref named exactly `full` exists (gix also tries other
    /// spellings of a name; those do not count).
    fn exists(&self, full: &str) -> Result<bool, Unsupported> {
        match self.repo.try_find_reference(full) {
            Ok(Some(found)) => Ok(found.name().as_bstr() == full.as_bytes()),
            Ok(None) => Ok(false),
            Err(_) => Err(Unsupported("a reference could not be read")),
        }
    }

    /// `refs_shorten_unambiguous_ref`: the shortest name that no other rule
    /// resolves, else the full name.
    fn shorten(&self, full: &str) -> Result<String, Unsupported> {
        for (at, (prefix, suffix)) in RULES.iter().enumerate().skip(1).rev() {
            let Some(short) = full.strip_prefix(prefix).and_then(|rest| rest.strip_suffix(suffix)) else { continue };
            if short.is_empty() {
                continue;
            }
            let checked = if self.strict { RULES.len() } else { at };
            let mut ambiguous = false;
            for (other, (prefix, suffix)) in RULES.iter().enumerate().take(checked) {
                if other == at {
                    continue;
                }
                if other == 0 {
                    // A file of that name at the top of a git folder may be a ref only git reads.
                    if self.dirs.git_dir.join(short).exists() || self.dirs.common_dir.join(short).exists() {
                        return Err(Unsupported("a short name is also a file in the git folder"));
                    }
                    continue;
                }
                if self.exists(&format!("{prefix}{short}{suffix}"))? {
                    ambiguous = true;
                    break;
                }
            }
            if !ambiguous {
                return Ok(short.to_owned());
            }
        }
        Ok(full.to_owned())
    }

    /// `branch_get_upstream`: the remote-tracking ref of `branch.<b>.merge`
    /// through the fetch refspecs of `branch.<b>.remote` (the merge ref
    /// itself when the remote is `.`), whether or not that ref exists.
    fn upstream_of(&self, branch: &gix::refs::FullName) -> Result<Option<String>, Unsupported> {
        let full = text(branch.as_bstr())?;
        let Some(short) = full.strip_prefix("refs/heads/") else { return Ok(None) };
        let config = self.repo.config_snapshot();
        let file = config.plumbing();
        let merges = file.strings_by("branch", Some(short.as_bytes().as_bstr()), "merge").unwrap_or_default();
        let Some(remote) = file.string_by("branch", Some(short.as_bytes().as_bstr()), "remote") else {
            return Ok(None);
        };
        let merge = match merges.as_slice() {
            [] => return Ok(None),
            [one] if one.starts_with(b"refs/") => text(one)?,
            _ => return Err(Unsupported("branch.<name>.merge is not one full ref name")),
        };
        if remote.as_bytes() == b"." {
            return Ok(Some(merge));
        }
        let fetch = file.strings_by("remote", Some(remote.as_bstr()), "fetch").unwrap_or_default();
        if fetch.iter().any(|spec| spec.starts_with(b"^")) {
            return Err(Unsupported("negative fetch refspecs"));
        }
        match self.repo.branch_remote_tracking_ref_name(branch.as_ref(), gix::remote::Direction::Fetch) {
            None => Ok(None),
            Some(Ok(tracking)) => Ok(Some(text(tracking.as_bstr())?)),
            Some(Err(_)) => Err(Unsupported("the tracking ref could not be found")),
        }
    }

    /// Commits HEAD has that `tracking` lacks, and the other way round.
    fn ahead_behind(&self, tracking: &str) -> Result<SyncStatus, Unsupported> {
        let head = self.repo.head_id().map_err(unsupported("HEAD did not resolve"))?.detach();
        let mut upstream = self.repo.find_reference(tracking).map_err(unsupported("the upstream did not resolve"))?;
        let upstream = upstream.peel_to_id().map_err(unsupported("the upstream did not resolve"))?.detach();
        let count = |tip: gix::ObjectId, hidden: gix::ObjectId| -> Result<u32, Unsupported> {
            let walk = self.repo.rev_walk([tip]).with_hidden([hidden]).all().map_err(unsupported("history walk"))?;
            let mut n = 0u32;
            for commit in walk {
                commit.map_err(unsupported("history walk"))?;
                n += 1;
            }
            Ok(n)
        };
        Ok(SyncStatus { ahead: count(head, upstream)?, behind: count(upstream, head)? })
    }

    /// `git remote`: every remote configured with at least one key, sorted.
    fn remotes(&self) -> Result<Vec<String>, Unsupported> {
        let config = self.repo.config_snapshot();
        let mut names = Vec::new();
        for section in config.plumbing().sections_by_name("remote").into_iter().flatten() {
            if let Some(name) = section.header().subsection_name()
                && section.value_names().next().is_some()
            {
                names.push(text(name)?);
            }
        }
        names.sort();
        names.dedup();
        Ok(names)
    }

    /// `git remote get-url origin`: its first URL.
    fn origin_url(&self, remotes: &[String]) -> Result<Option<String>, Unsupported> {
        if !remotes.iter().any(|r| r == "origin") {
            return Ok(None);
        }
        let config = self.repo.config_snapshot();
        let urls = config.plumbing().strings_by("remote", Some(b"origin".as_bstr()), "url").unwrap_or_default();
        if urls.iter().any(|url| url.is_empty()) {
            return Err(Unsupported("an empty remote URL"));
        }
        let Some(first) = urls.first() else { return Ok(None) };
        let first = text(first)?;
        let first = first.trim();
        Ok((!first.is_empty()).then(|| web_url(first)))
    }

    /// `git stash list`: one line per entry of the stash's reflog.
    fn stash_count(&self) -> Result<u32, Unsupported> {
        let Some(stash) =
            self.repo.try_find_reference("refs/stash").map_err(unsupported("the stash could not be read"))?
        else {
            return Ok(0);
        };
        if stash.name().as_bstr() != "refs/stash" {
            return Ok(0);
        }
        let mut log = stash.log_iter();
        let Some(entries) = log.all().map_err(unsupported("the stash's log could not be read"))? else {
            return Err(Unsupported("a stash without its log"));
        };
        let mut n = 0u32;
        for entry in entries {
            entry.map_err(unsupported("the stash's log could not be read"))?;
            n += 1;
        }
        Ok(n)
    }

    /// `git branch --format=%(refname:short)`: by full name, byte order.
    fn branches(&self) -> Result<Vec<String>, Unsupported> {
        let platform = self.repo.references().map_err(unsupported("refs could not be listed"))?;
        let mut names = Vec::new();
        for branch in platform.local_branches().map_err(unsupported("refs could not be listed"))? {
            let branch = branch.map_err(unsupported("a branch could not be read"))?;
            names.push(text(branch.name().as_bstr())?);
        }
        names.sort();
        names.iter().map(|name| self.shorten(name)).collect()
    }
}

/// Settings and repository shapes gix may read differently from git.
fn check_supported(repo: &gix::Repository, dirs: &GitDirs) -> Result<(), Unsupported> {
    if repo.git_dir_trust() != gix::sec::Trust::Full {
        return Err(Unsupported("the folder is not trusted"));
    }
    let config = repo.config_snapshot();
    let file = config.plumbing();
    if file.string("extensions.refStorage").is_some_and(|storage| storage.as_bytes() != b"files") {
        return Err(Unsupported("refs are not stored as files"));
    }
    if file.string("branch.sort").is_some() {
        return Err(Unsupported("branches have a configured order"));
    }
    if file.sections_by_name("url").is_some_and(|mut sections| sections.next().is_some()) {
        return Err(Unsupported("URLs are rewritten"));
    }
    if repo.is_shallow().map_err(unsupported("shallow"))? {
        return Err(Unsupported("shallow history"));
    }
    let platform = repo.references().map_err(unsupported("refs could not be listed"))?;
    if platform.prefixed(b"refs/replace/".as_bstr()).map_err(unsupported("refs"))?.next().is_some() {
        return Err(Unsupported("replaced objects"));
    }
    for legacy in ["remotes", "branches"] {
        if std::fs::read_dir(dirs.common_dir.join(legacy)).is_ok_and(|mut entries| entries.next().is_some()) {
            return Err(Unsupported("remotes defined outside the configuration"));
        }
    }
    Ok(())
}

fn boolean(file: &gix::config::File, key: &str, default: bool) -> Result<bool, Unsupported> {
    match file.boolean(key) {
        Ok(value) => Ok(value.unwrap_or(default)),
        Err(_) => Err(Unsupported("a setting is not a boolean")),
    }
}

/// The refs as gix reads them. Blocking: run off the async workers.
pub(super) fn read(repo: &gix::Repository, dirs: &GitDirs) -> Result<Read, Unsupported> {
    check_supported(repo, dirs)?;
    let config = repo.config_snapshot();
    let (strict, diff_relative) = (
        boolean(config.plumbing(), "core.warnAmbiguousRefs", true)?,
        boolean(config.plumbing(), "diff.relative", false)?,
    );
    let reader = Reader { repo, dirs, strict };

    let head = repo.head().map_err(unsupported("HEAD could not be read"))?;
    let (branch, born) = match head.kind {
        gix::head::Kind::Symbolic(referent) => {
            if matches!(referent.target, gix::refs::Target::Symbolic(_)) {
                return Err(Unsupported("HEAD points at a symbolic ref"));
            }
            (Some(referent.name), true)
        }
        gix::head::Kind::Unborn(name) => (Some(name), false),
        gix::head::Kind::Detached { .. } => (None, true),
    };
    let full = branch.as_ref().map(|name| text(name.as_bstr())).transpose()?;
    let current_branch = match full.as_deref().map(|name| name.strip_prefix("refs/heads/")) {
        None => None,
        Some(Some(short)) => Some(short.to_owned()),
        Some(None) => return Err(Unsupported("HEAD points outside refs/heads")),
    };

    let tracking = match &branch {
        Some(name) => reader.upstream_of(name)?,
        None => None,
    };
    let upstream = match tracking {
        Some(tracking) if reader.exists(&tracking)? => Some(tracking),
        _ => None,
    };
    let sync = match &upstream {
        Some(tracking) if born => Some(reader.ahead_behind(tracking)?),
        _ => None,
    };
    let upstream = upstream.map(|tracking| reader.shorten(&tracking)).transpose()?;
    let remotes = reader.remotes()?;
    let mut remote =
        upstream.as_deref().and_then(|up| up.split('/').next().filter(|r| !r.is_empty()).map(str::to_owned));
    if remote.is_none() {
        remote =
            if remotes.iter().any(|r| r == "origin") { Some("origin".to_owned()) } else { remotes.first().cloned() };
    }
    let push = PushState {
        branch: match (&full, born) {
            (Some(full), true) => Some(reader.shorten(full)?).filter(|short| short != "HEAD"),
            _ => None,
        },
        remote,
        has_upstream: upstream.is_some(),
        ahead: if upstream.is_some() { sync.map_or(0, |s| s.ahead) } else { 0 },
        behind: if upstream.is_some() { sync.map_or(0, |s| s.behind) } else { 0 },
    };
    let detached = branch.is_none();
    let refs = Refs {
        current_branch,
        branches: if detached { Vec::new() } else { reader.branches()? },
        remote_url: reader.origin_url(&remotes)?,
        remotes,
        sync,
        push,
        stash: reader.stash_count()?,
        diff_relative,
    };
    Ok(Read { refs, detached })
}

/// The refs as the git commands answer them.
pub(super) async fn by_git(git: &Git, top: &Path) -> Refs {
    let (current_branch, branches, remotes, remote_url, sync, stash, push, relative) = tokio::join!(
        git.current_branch(top),
        git.list_branches(top),
        git.remotes(top),
        git.remote_url(top),
        git.sync_status(top),
        git.stash_count(top),
        git.push_state(top),
        git.line(top, &["config", "--type=bool", "--get", "diff.relative"]),
    );
    Refs {
        current_branch,
        branches,
        remotes,
        remote_url,
        sync,
        push,
        stash,
        diff_relative: relative.as_deref() == Some("true"),
    }
}
