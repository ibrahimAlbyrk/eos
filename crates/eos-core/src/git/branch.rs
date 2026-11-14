use std::path::Path;

use eos_contracts::{BranchDeleteResponse, BranchOpResponse, FetchResponse, RemoteBranchDeleteResponse};
use eos_domain::git::pull_plan::PullExecReason;
use eos_domain::git::push_plan::{PushExecReason, PushTarget};

use super::{CommandFailed, OpResult};
use crate::BoxFuture;

/// Switching branches and moving stashes.
pub trait WorkingTree: Send + Sync {
    fn checkout<'a>(&'a self, cwd: &'a Path, branch: &'a str) -> BoxFuture<'a, Result<(), CommandFailed>>;
    /// Sets the tracked changes aside. Succeeds with nothing to stash.
    fn stash_push<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Result<(), CommandFailed>>;
    /// Restores a stash, leaving its entry in place. A conflict is a failed
    /// result carrying git's message.
    fn stash_apply<'a>(&'a self, cwd: &'a Path, index: u32) -> BoxFuture<'a, OpResult>;
    fn stash_drop<'a>(&'a self, cwd: &'a Path, index: u32) -> BoxFuture<'a, OpResult>;
}

/// Local branches: nothing here talks to a remote.
pub trait BranchAdmin: Send + Sync {
    /// Creates `name` at `start_point` (HEAD when `None`), switching to it when `checkout`.
    fn create<'a>(
        &'a self,
        cwd: &'a Path,
        name: &'a str,
        start_point: Option<&'a str>,
        checkout: bool,
    ) -> BoxFuture<'a, BranchOpResponse>;
    fn rename<'a>(&'a self, cwd: &'a Path, from: &'a str, to: &'a str) -> BoxFuture<'a, BranchOpResponse>;
    /// Without `force`, a branch that is not fully merged is refused with
    /// `not_merged` set, so the caller can offer to force.
    fn remove<'a>(&'a self, cwd: &'a Path, name: &'a str, force: bool) -> BoxFuture<'a, BranchDeleteResponse>;
}

/// A pull that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullExec {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub reason: PullExecReason,
}

pub trait RemoteSync: Send + Sync {
    /// Fetches `remote`, or every remote when `None`. The working tree is untouched.
    fn fetch<'a>(&'a self, cwd: &'a Path, remote: Option<&'a str>, prune: bool) -> BoxFuture<'a, FetchResponse>;
    /// `git pull --ff-only`: the only pull that ever runs.
    fn pull<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PullExec>;
    fn delete_remote_branch<'a>(
        &'a self,
        cwd: &'a Path,
        remote: &'a str,
        branch: &'a str,
    ) -> BoxFuture<'a, RemoteBranchDeleteResponse>;
}

/// A push that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushExec {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub reason: PushExecReason,
}

pub trait BranchPush: Send + Sync {
    /// Runs a push that `decide_push_plan` already chose.
    fn push<'a>(&'a self, cwd: &'a Path, target: &'a PushTarget) -> BoxFuture<'a, PushExec>;
}
