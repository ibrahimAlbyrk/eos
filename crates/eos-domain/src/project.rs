//! Projects: a name and the source folders that belong together.

pub use eos_contracts::Project;

/// The extra source folders a session gets beyond its own working folder: the
/// other folders of the first project that owns any of `paths` (the worker's
/// folder, and the source repository when it runs in a worktree). Empty when
/// no project claims one.
pub fn additional_dirs_for(projects: &[Project], paths: &[Option<&str>]) -> Vec<String> {
    let own: Vec<&str> = paths.iter().flatten().copied().filter(|p| !p.is_empty()).collect();
    projects
        .iter()
        .find(|p| p.folders.iter().any(|f| own.contains(&f.as_str())))
        .map(|p| p.folders.iter().filter(|f| !own.contains(&f.as_str())).cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, folders: &[&str]) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            icon: None,
            folders: folders.iter().map(|f| (*f).to_owned()).collect(),
            pinned: None,
        }
    }

    #[test]
    fn a_session_gets_the_other_folders_of_its_project() {
        let projects = [project("a", &["/a/app", "/a/lib"]), project("b", &["/b", "/a/lib"])];
        assert_eq!(additional_dirs_for(&projects, &[Some("/a/app")]), ["/a/lib"]);
        assert_eq!(additional_dirs_for(&projects, &[None, Some("/a/lib")]), ["/a/app"], "the first owner wins");
        assert_eq!(additional_dirs_for(&projects, &[Some("/a/app"), Some("/a/lib")]), Vec::<String>::new());
        assert_eq!(additional_dirs_for(&projects, &[Some("/elsewhere"), None]), Vec::<String>::new());
    }
}
