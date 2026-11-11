//! The git panels: branches, history, changes in each scope, blobs, stashes,
//! and the operations that change a repository.

use std::path::Path;

use eos_contracts::{
    BranchCreateRequest, BranchDeleteRequest, BranchRenameRequest, BranchesQuery, BranchesResponse, ChangedFile,
    ChangedFileStatus, CommitFileStatus, FetchRequest, FsBlobQuery, FsChangesFileQuery, FsChangesQuery,
    FsChangesResponse, FsCheckoutRequest, FsLogQuery, FsLogResponse, FsStashApplyRequest, FsStashDropRequest,
    FsStashesQuery, FsStashesResponse, RemoteBranchDeleteRequest, UnpushedResponse,
};
use eos_domain::git::branch_order::order_branches;
use eos_domain::git::changes::{PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES, attach_patches};
use eos_kit_fs::path::is_repo_relative;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::Deps;
use crate::branches::{checkout_branch, create_branch, rename_branch};
use crate::http::{
    CHANGE, DASHBOARD, Handled, READ, abs_path, bad, extension, guard_mutation, handler, image_mime, query,
};

/// The largest blob served: past it the panel shows a size note instead.
const BLOB_MAX_BYTES: u64 = 20 * 1024 * 1024;

fn cwd_of(cwd: &str) -> Result<std::path::PathBuf, ApiError> {
    abs_path(Some(cwd), "cwd must be absolute")
}

fn is_sha(text: &str) -> bool {
    (4..=40).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn branches(deps: Deps, req: Request) -> Handled {
    let q: BranchesQuery = query(&req, &["cwd"])?;
    let cwd = cwd_of(&q.cwd)?;
    let cwd = cwd.as_path();
    // `remotes=1` (the branch picker) adds remote-tracking branches and
    // remote names, and orders local branches by recent checkout; the status
    // row leaves all that out.
    let want_remotes = req.query().get("remotes").as_deref() == Some("1");
    let git = deps.git.as_ref();
    let (is_git, branches, current, remote_url, sync, stash, conflicts) = tokio::join!(
        git.is_repo(cwd),
        git.list_branches(cwd),
        git.current_branch(cwd),
        git.remote_url(cwd),
        git.sync_status(cwd),
        git.stash_count(cwd),
        git.conflict_count(cwd),
    );
    let (branches, remote_branches, remotes) = if want_remotes {
        let (remote_branches, remotes, usage) =
            tokio::join!(git.remote_branches(cwd), git.remotes(cwd), git.recent_checkouts(cwd));
        (order_branches(&branches, &usage, current.as_deref()), Some(remote_branches), Some(remotes))
    } else {
        (branches, None, None)
    };
    Ok(Response::json(
        200,
        &BranchesResponse {
            branches,
            current,
            is_git,
            remote_url,
            ahead: sync.map(|s| i64::from(s.ahead)),
            behind: sync.map(|s| i64::from(s.behind)),
            stash: i64::from(stash),
            conflicts: i64::from(conflicts),
            remote_branches,
            remotes,
        },
    ))
}

async fn unpushed(deps: Deps, req: Request) -> Handled {
    let q: BranchesQuery = query(&req, &["cwd"])?;
    let cwd = cwd_of(&q.cwd)?;
    Ok(Response::json(200, &UnpushedResponse { commits: deps.git.unpushed_commits(&cwd).await }))
}

async fn commit(deps: Deps, req: Request) -> Handled {
    let q: BranchesQuery = query(&req, &["cwd"])?;
    let sha = req.query().get("sha").unwrap_or_default().into_owned();
    let cwd = cwd_of(&q.cwd)?;
    if !is_sha(&sha) {
        return Err(bad("valid sha required"));
    }
    match deps.git.commit_detail(&cwd, &sha).await {
        Some(detail) => Ok(Response::json(200, &detail)),
        None => Err(ApiError::NotFound("commit not found".into())),
    }
}

async fn log(deps: Deps, req: Request) -> Handled {
    let q: FsLogQuery = query(&req, &["cwd", "limit", "skip"])?;
    let cwd = cwd_of(&q.cwd)?;
    let limit = u32::try_from(q.limit).unwrap_or(0);
    // One row more than asked for comes back: it only says there is more.
    let mut commits = deps.git.log(&cwd, limit, u32::try_from(q.skip).unwrap_or(0)).await;
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    Ok(Response::json(200, &FsLogResponse { commits, has_more }))
}

async fn stashes(deps: Deps, req: Request) -> Handled {
    let q: FsStashesQuery = query(&req, &["cwd"])?;
    let cwd = cwd_of(&q.cwd)?;
    Ok(Response::json(200, &FsStashesResponse { stashes: deps.git.stash_list(&cwd).await }))
}

/// The fork point a branch is compared against: `base` (`auto` = the
/// repository's usual base) as a ref, and its merge base with HEAD. `None`
/// when either does not resolve: the comparison is then against HEAD.
async fn resolve_base(deps: &Deps, cwd: &Path, base: &str) -> Option<(String, String)> {
    let reference = if base == "auto" { deps.git.default_base_ref(cwd).await? } else { base.to_owned() };
    let sha = deps.git.merge_base_ref(cwd, &reference).await?;
    Some((reference, sha))
}

/// The repository folder's name, for the panel's header.
async fn repo_label(deps: &Deps, cwd: &Path) -> Option<String> {
    let dirs = deps.git.git_dirs(cwd).await?;
    dirs.toplevel.file_name().map(|name| name.to_string_lossy().into_owned())
}

async fn changes(deps: Deps, req: Request) -> Handled {
    let q: FsChangesQuery = query(&req, &["cwd", "sha", "base"])?;
    let cwd = cwd_of(&q.cwd)?;
    let cwd = cwd.as_path();
    let want_patches = req.query().get("patches").as_deref() == Some("1");

    // One commit (or one stash): its own files against its first parent.
    if let Some(sha) = q.sha.filter(|s| !s.is_empty()) {
        let Some(detail) = deps.git.commit_detail(cwd, &sha).await else {
            return Err(ApiError::NotFound("commit not found".into()));
        };
        let mut files: Vec<ChangedFile> = detail
            .files
            .into_iter()
            .map(|f| ChangedFile {
                path: f.path,
                old_path: f.old_path,
                status: match f.status {
                    CommitFileStatus::M => ChangedFileStatus::M,
                    CommitFileStatus::A => ChangedFileStatus::A,
                    CommitFileStatus::D => ChangedFileStatus::D,
                    CommitFileStatus::R => ChangedFileStatus::R,
                },
                insertions: f.insertions,
                deletions: f.deletions,
                untracked: false,
                patch: None,
                binary: None,
                truncated: None,
            })
            .collect();
        let parent = format!("{sha}^");
        let (full, base_sha, repo_label) = tokio::join!(
            async { if want_patches { deps.git_diffs.commit_patch(cwd, &sha).await } else { None } },
            // No parent: a root commit, shown as everything added.
            deps.git.rev_parse(cwd, &parent),
            repo_label(&deps, cwd),
        );
        if let Some(full) = full {
            attach_patches(&mut files, &full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
        }
        return Ok(Response::json(
            200,
            &FsChangesResponse {
                files,
                insertions: detail.insertions,
                deletions: detail.deletions,
                base_sha,
                head_sha: Some(detail.sha.clone()),
                base_label: None,
                head_label: detail.sha,
                repo_label,
            },
        ));
    }

    // The working tree: against the branch's fork point when a base is given,
    // else against HEAD (uncommitted changes only).
    let base = match &q.base {
        Some(base) => resolve_base(&deps, cwd, &base.0).await,
        None => None,
    };
    let against = base.as_ref().map(|(_, sha)| sha.as_str());
    let (mut files, full, base_sha, head, repo_label) = tokio::join!(
        deps.git_diffs.changed_files(cwd, against),
        async { if want_patches { deps.git_diffs.full_diff(cwd, against).await } else { None } },
        deps.git.rev_parse(cwd, against.unwrap_or("HEAD")),
        deps.git.current_branch(cwd),
        repo_label(&deps, cwd),
    );
    if let Some(full) = full {
        attach_patches(&mut files, &full, PATCH_MAX_BYTES, PATCHES_TOTAL_MAX_BYTES);
    }
    Ok(Response::json(
        200,
        &FsChangesResponse {
            insertions: files.iter().map(|f| f.insertions.unwrap_or(0)).sum(),
            deletions: files.iter().map(|f| f.deletions.unwrap_or(0)).sum(),
            files,
            // A detached HEAD has no branch name: the short sha stands in.
            head_label: head.or_else(|| base_sha.clone()).unwrap_or_else(|| "HEAD".to_owned()),
            base_sha,
            head_sha: None,
            base_label: base.map(|(reference, _)| reference),
            repo_label,
        },
    ))
}

async fn changes_file(deps: Deps, req: Request) -> Handled {
    let q: FsChangesFileQuery = query(&req, &["cwd", "path", "oldPath", "sha", "base"])?;
    let cwd = cwd_of(&q.cwd)?;
    let old_path = q.old_path.as_deref().filter(|p| !p.is_empty());
    if let Some(sha) = q.sha.as_deref().filter(|s| !s.is_empty()) {
        return Ok(Response::json(200, &deps.git_diffs.commit_file_diff(&cwd, sha, &q.path, old_path).await));
    }
    let base = match &q.base {
        Some(base) => resolve_base(&deps, &cwd, &base.0).await,
        None => None,
    };
    let against = base.as_ref().map(|(_, sha)| sha.as_str());
    Ok(Response::json(200, &deps.git_diffs.file_diff(&cwd, &q.path, old_path, against).await))
}

async fn blob(deps: Deps, req: Request) -> Handled {
    let q: FsBlobQuery = query(&req, &["cwd", "ref", "path"])?;
    let cwd = cwd_of(&q.cwd)?;
    if !is_repo_relative(&q.path) {
        return Err(bad("path must be repo-relative"));
    }
    if let Some(size) = deps.git_diffs.blob_size_at_ref(&cwd, &q.r#ref, &q.path).await
        && size > BLOB_MAX_BYTES
    {
        return Err(ApiError::status_with(413, format!("blob too large ({size} bytes, limit {BLOB_MAX_BYTES})")));
    }
    let Some(data) = deps.git_diffs.blob_at_ref(&cwd, &q.r#ref, &q.path).await else {
        return Err(ApiError::NotFound("blob not found".into()));
    };
    // Content named by a commit never changes.
    Ok(Response::bytes(200, image_mime(&extension(&q.path)), data)
        .header("cache-control", "public, max-age=86400, immutable"))
}

async fn checkout(deps: Deps, req: Request) -> Handled {
    let body: FsCheckoutRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    let done =
        checkout_branch(deps.git.as_ref(), deps.tree.as_ref(), &cwd, &body.branch, body.stash.unwrap_or(false)).await;
    Ok(Response::json(200, &done))
}

fn stash_index(index: i64) -> u32 {
    u32::try_from(index).unwrap_or(u32::MAX)
}

async fn stash_apply(deps: Deps, req: Request) -> Handled {
    let body: FsStashApplyRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    Ok(Response::json(200, &deps.tree.stash_apply(&cwd, stash_index(body.index)).await))
}

async fn stash_drop(deps: Deps, req: Request) -> Handled {
    let body: FsStashDropRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    Ok(Response::json(200, &deps.tree.stash_drop(&cwd, stash_index(body.index)).await))
}

// A git failure in the routes below is still a 200: the body says `ok: false`
// with git's message, and the dashboard shows it in place.

async fn branch_create(deps: Deps, req: Request) -> Handled {
    let body: BranchCreateRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    let made =
        create_branch(deps.branches.as_ref(), &cwd, &body.name, body.start_point.as_deref(), body.checkout).await;
    Ok(Response::json(200, &made))
}

async fn branch_rename(deps: Deps, req: Request) -> Handled {
    let body: BranchRenameRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    Ok(Response::json(200, &rename_branch(deps.branches.as_ref(), &cwd, &body.from, &body.to).await))
}

async fn branch_delete(deps: Deps, req: Request) -> Handled {
    let body: BranchDeleteRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    Ok(Response::json(200, &deps.branches.remove(&cwd, &body.name, body.force.unwrap_or(false)).await))
}

async fn fetch(deps: Deps, req: Request) -> Handled {
    let body: FetchRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    Ok(Response::json(200, &deps.remotes.fetch(&cwd, None, body.prune.unwrap_or(true)).await))
}

async fn remote_branch_delete(deps: Deps, req: Request) -> Handled {
    let body: RemoteBranchDeleteRequest = req.parse()?;
    let cwd = guard_mutation(&req, &body.cwd)?;
    Ok(Response::json(200, &deps.remotes.delete_remote_branch(&cwd, &body.remote, &body.branch).await))
}

pub(crate) fn routes(deps: &Deps) -> Vec<RouteDef> {
    // A change the phone has no rule for: the handler still asks for the user.
    let user_only = Access::open();
    vec![
        RouteDef::get("/fs/branches", handler(deps, branches)).access(READ),
        RouteDef::get("/fs/unpushed", handler(deps, unpushed)).access(READ),
        RouteDef::get("/fs/commit", handler(deps, commit)).access(READ),
        RouteDef::get("/fs/log", handler(deps, log)).access(DASHBOARD),
        RouteDef::get("/fs/stashes", handler(deps, stashes)).access(DASHBOARD),
        RouteDef::get("/fs/changes", handler(deps, changes)).access(DASHBOARD),
        RouteDef::get("/fs/changes/file", handler(deps, changes_file)).access(DASHBOARD),
        RouteDef::get("/fs/blob", handler(deps, blob)).access(DASHBOARD),
        RouteDef::post("/fs/checkout", handler(deps, checkout)).access(CHANGE),
        RouteDef::post("/fs/stash/apply", handler(deps, stash_apply)).access(user_only),
        RouteDef::post("/fs/stash/drop", handler(deps, stash_drop)).access(user_only),
        RouteDef::post("/fs/branch/create", handler(deps, branch_create)).access(CHANGE),
        RouteDef::post("/fs/branch/rename", handler(deps, branch_rename)).access(CHANGE),
        RouteDef::post("/fs/branch/delete", handler(deps, branch_delete)).access(CHANGE),
        RouteDef::post("/fs/fetch", handler(deps, fetch)).access(CHANGE),
        RouteDef::post("/fs/remote-branch/delete", handler(deps, remote_branch_delete)).access(CHANGE),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sha_is_four_to_forty_hex_digits() {
        for yes in ["abcd", "9D3E8E2", &"a".repeat(40)] {
            assert!(is_sha(yes), "{yes}");
        }
        for no in ["zz", "abc", "", &"a".repeat(41), "abcg"] {
            assert!(!is_sha(no), "{no}");
        }
    }
}
