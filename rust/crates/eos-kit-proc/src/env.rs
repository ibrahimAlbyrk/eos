//! What a child sees of this process's environment.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// Rules that turn the parent's environment into a child's. Applied in this
/// order: keep (everything, or only an allow-list), remove, set, append to `PATH`.
#[derive(Debug, Clone, Default)]
pub struct Env {
    allow: Option<Vec<OsString>>,
    remove: Vec<OsString>,
    remove_prefixes: Vec<String>,
    set: Vec<(OsString, OsString)>,
    path_append: Vec<PathBuf>,
}

impl Env {
    /// The child gets the parent's variables.
    pub fn inherit() -> Self {
        Self::default()
    }

    /// The child gets only these of the parent's variables.
    pub fn only<I, S>(names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self { allow: Some(names.into_iter().map(Into::into).collect()), ..Self::default() }
    }

    /// The child gets nothing of the parent's.
    pub fn empty() -> Self {
        Self::only(std::iter::empty::<OsString>())
    }

    /// Never passes this variable on, whatever the parent has.
    pub fn without(mut self, name: impl Into<OsString>) -> Self {
        self.remove.push(name.into());
        self
    }

    /// Never passes on a variable whose name starts with `prefix`.
    pub fn without_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.remove_prefixes.push(prefix.into());
        self
    }

    pub fn set(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.set.push((name.into(), value.into()));
        self
    }

    /// Makes `PATH` also reach `dir`, last, so a program found earlier still wins.
    pub fn append_path(mut self, dir: impl Into<PathBuf>) -> Self {
        self.path_append.push(dir.into());
        self
    }

    fn kept(&self, name: &OsStr) -> bool {
        self.allow.as_ref().is_none_or(|allow| allow.iter().any(|a| a == name))
            && !self.remove.iter().any(|r| r == name)
            && !self.remove_prefixes.iter().any(|p| name.to_string_lossy().starts_with(p.as_str()))
    }

    /// The child's variables, given the parent's.
    pub fn resolve(&self, parent: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
        let mut vars: Vec<(OsString, OsString)> = parent.into_iter().filter(|(name, _)| self.kept(name)).collect();
        for (name, value) in &self.set {
            match vars.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 = value.clone(),
                None => vars.push((name.clone(), value.clone())),
            }
        }
        for dir in &self.path_append {
            // Whichever spelling of the name is there is kept (Windows writes "Path").
            let at = vars.iter().position(|(n, _)| n.to_string_lossy().eq_ignore_ascii_case("PATH"));
            let mut dirs: Vec<PathBuf> = at.map(|i| std::env::split_paths(&vars[i].1).collect()).unwrap_or_default();
            if dirs.contains(dir) {
                continue;
            }
            dirs.push(dir.clone());
            let Ok(joined) = std::env::join_paths(dirs) else { continue };
            match at {
                Some(i) => vars[i].1 = joined,
                None => vars.push((OsString::from("PATH"), joined)),
            }
        }
        vars
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent() -> Vec<(OsString, OsString)> {
        [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/Users/me"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("LANG", "en_US.UTF-8"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect()
    }

    fn names(vars: &[(OsString, OsString)]) -> Vec<String> {
        let mut names: Vec<String> = vars.iter().map(|(n, _)| n.to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn get(vars: &[(OsString, OsString)], name: &str) -> Option<String> {
        vars.iter().find(|(n, _)| n == name).map(|(_, v)| v.to_string_lossy().into_owned())
    }

    #[test]
    fn inherit_passes_everything_on() {
        assert_eq!(Env::inherit().resolve(parent()).len(), 6);
    }

    #[test]
    fn an_allow_list_passes_on_only_what_it_names() {
        let vars = Env::only(["PATH", "HOME", "NOT_SET"]).resolve(parent());
        assert_eq!(names(&vars), ["HOME", "PATH"]);
        assert!(Env::empty().resolve(parent()).is_empty());
    }

    // The shape of core/src/domain/env-allowlist.ts: the subscription child
    // loses the variables that divert billing and the parent session's markers.
    #[test]
    fn named_variables_and_prefixes_are_removed() {
        let vars = Env::inherit()
            .without("ANTHROPIC_API_KEY")
            .without("CLAUDECODE")
            .without_prefix("CLAUDE_CODE_")
            .resolve(parent());
        assert_eq!(names(&vars), ["HOME", "LANG", "PATH"]);
    }

    #[test]
    fn set_adds_and_replaces_and_wins_over_removal() {
        let vars = Env::only(["PATH"])
            .without("HOME")
            .set("HOME", "/tmp/home")
            .set("GIT_TERMINAL_PROMPT", "0")
            .set("PATH", "/only")
            .resolve(parent());
        assert_eq!(get(&vars, "HOME").as_deref(), Some("/tmp/home"));
        assert_eq!(get(&vars, "GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
        assert_eq!(get(&vars, "PATH").as_deref(), Some("/only"));
        assert_eq!(vars.len(), 3);
    }

    #[test]
    fn a_folder_is_appended_to_path_once_under_the_name_already_there() {
        let vars = Env::inherit().append_path("/opt/eos/bin").append_path("/bin").resolve(parent());
        assert_eq!(get(&vars, "PATH").as_deref(), Some("/usr/bin:/bin:/opt/eos/bin"));

        let windows = vec![(OsString::from("Path"), OsString::from("/a"))];
        let vars = Env::inherit().append_path("/b").resolve(windows);
        assert_eq!(get(&vars, "Path").as_deref(), Some("/a:/b"));
        assert_eq!(vars.len(), 1);

        let vars = Env::empty().append_path("/b").resolve(parent());
        assert_eq!(get(&vars, "PATH").as_deref(), Some("/b"));
    }
}
