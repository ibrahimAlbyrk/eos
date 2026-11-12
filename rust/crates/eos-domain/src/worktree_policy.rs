//! Where a spawned worker works (`core/src/domain/worktree-policy.ts`).

/// Whether a worker definition asks for a worktree of its own or the folder as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    Worktree,
    Cwd,
}

/// The folder and the repository a spawn ends up with.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SpawnIsolation {
    pub cwd: Option<String>,
    pub worktree_from: Option<String>,
}

/// - attaching to another worker's worktree keeps what was asked;
/// - worktrees switched off (the user's setting), or a definition that works
///   in the folder itself, turn a worktree request into that folder;
/// - a definition that wants its own worktree turns a plain folder into one;
/// - anything else is as asked.
pub fn resolve_spawn_isolation(
    cwd: Option<String>,
    worktree_from: Option<String>,
    attaches: bool,
    worktrees_disabled: bool,
    definition: Option<Isolation>,
) -> SpawnIsolation {
    if attaches {
        return SpawnIsolation { cwd, worktree_from };
    }
    if (worktrees_disabled || definition == Some(Isolation::Cwd)) && worktree_from.is_some() {
        return SpawnIsolation { cwd: worktree_from, worktree_from: None };
    }
    if !worktrees_disabled && definition == Some(Isolation::Worktree) && cwd.is_some() && worktree_from.is_none() {
        return SpawnIsolation { cwd: None, worktree_from: cwd };
    }
    SpawnIsolation { cwd, worktree_from }
}

#[cfg(test)]
mod tests {
    use super::*;

    // core/src/__tests__/worktree-policy.test.ts
    #[test]
    fn a_spawn_works_in_a_worktree_or_in_the_folder_itself() {
        let some = |s: &str| Some(s.to_owned());
        let at = |cwd: Option<&str>, from: Option<&str>| SpawnIsolation {
            cwd: cwd.map(str::to_owned),
            worktree_from: from.map(str::to_owned),
        };
        assert_eq!(resolve_spawn_isolation(some("/r"), None, false, false, None), at(Some("/r"), None));
        assert_eq!(resolve_spawn_isolation(None, some("/r"), false, false, None), at(None, Some("/r")));
        assert_eq!(
            resolve_spawn_isolation(None, some("/r"), false, true, None),
            at(Some("/r"), None),
            "worktrees are off"
        );
        assert_eq!(resolve_spawn_isolation(None, some("/r"), false, false, Some(Isolation::Cwd)), at(Some("/r"), None));
        assert_eq!(
            resolve_spawn_isolation(some("/r"), None, false, false, Some(Isolation::Worktree)),
            at(None, Some("/r"))
        );
        assert_eq!(
            resolve_spawn_isolation(some("/r"), None, false, true, Some(Isolation::Worktree)),
            at(Some("/r"), None)
        );
        assert_eq!(
            resolve_spawn_isolation(some("/a"), some("/r"), true, true, Some(Isolation::Cwd)),
            at(Some("/a"), Some("/r"))
        );
    }
}
