//! The skills and slash commands of a folder, before any session runs there:
//! what the engine would find for a session in that folder, listed as the
//! composer's menu reads it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use eos_agent_compat::ClaudePaths;
use eos_agent_skills::{Origin, SkillCatalog, SkillRoots};
use eos_contracts::{CommandItem, CommandItemSource};

/// The menu's order: the folder's commands and skills, the user's commands
/// and skills, the plugins', the bundled ones.
fn rank(origin: &Origin) -> (u8, CommandItemSource) {
    match origin {
        Origin::ProjectCommand => (0, CommandItemSource::Project),
        Origin::ProjectSkill => (1, CommandItemSource::Project),
        Origin::UserCommand => (2, CommandItemSource::User),
        Origin::UserSkill => (3, CommandItemSource::Skill),
        Origin::PluginSkill { .. } | Origin::PluginCommand { .. } => (4, CommandItemSource::Plugin),
        Origin::Bundled => (5, CommandItemSource::Claude),
    }
}

/// Reads the folder's, the user's and the plugins' skill files (blocking).
/// Without a folder the bundled skills are left out, as today. A name found
/// twice is the one a session would run (the engine's precedence).
pub(crate) fn folder_commands(paths: &ClaudePaths, plugin_dirs: &[PathBuf], cwd: Option<&Path>) -> Vec<CommandItem> {
    let roots = SkillRoots {
        user_dir: Some(paths.config_dir.clone()),
        cwd: cwd.map(Path::to_path_buf),
        home: Some(paths.home.clone()),
        plugin_dirs: plugin_dirs.to_vec(),
        installed_plugins: true,
        bundled: cwd.is_some(),
        ..SkillRoots::default()
    };
    let mut skills: Vec<_> = SkillCatalog::discover(&roots).skills().into_iter().filter(|s| s.user_invocable).collect();
    skills.sort_by_key(|s| rank(&s.origin).0);
    // Names compare without case: the engine lowercases a skill's name.
    let mut seen = HashSet::new();
    skills
        .into_iter()
        .filter(|s| seen.insert(s.name.to_lowercase()))
        .map(|s| CommandItem {
            name: s.name.clone(),
            description: s.description.clone(),
            source: rank(&s.origin).1,
            argument_hint: s.argument_hint.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: PathBuf, text: &str) {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("folders");
        std::fs::write(path, text).expect("written");
    }

    #[test]
    fn a_folder_lists_its_own_first_and_a_name_once() {
        let home = tempfile::tempdir().expect("a home");
        let paths = ClaudePaths::for_home(home.path());
        let project = home.path().join("project");
        write(
            paths.config_dir.join("commands/hello.md"),
            "---\ndescription: Say hello\nargument-hint: \"[name]\"\n---\nHi $ARGUMENTS",
        );
        write(paths.config_dir.join("commands/shared.md"), "---\ndescription: The user's\n---\nmine");
        write(project.join(".claude/commands/shared.md"), "---\ndescription: The folder's\n---\nours");

        let without_folder = folder_commands(&paths, &[], None);
        let names: Vec<_> = without_folder.iter().map(|c| (c.name.as_str(), c.source)).collect();
        assert!(names.contains(&("hello", CommandItemSource::User)), "{names:?}");
        assert!(
            without_folder.iter().all(|c| c.source != CommandItemSource::Claude),
            "no bundled ones without a folder"
        );
        let hello = without_folder.iter().find(|c| c.name == "hello").expect("hello");
        assert_eq!((hello.description.as_str(), hello.argument_hint.as_deref()), ("Say hello", Some("[name]")));

        write(project.join(".claude/commands/build.md"), "---\ndescription: Build it\n---\nmake");
        let in_folder = folder_commands(&paths, &[], Some(&project));
        assert_eq!(in_folder.iter().filter(|c| c.name == "shared").count(), 1, "listed once");
        assert_eq!((in_folder[0].name.as_str(), in_folder[0].source), ("build", CommandItemSource::Project));
    }
}
