//! The Claude Code plugin that teaches agents to write Eos plugins (the
//! `eos-plugin-authoring` skill). It ships as plain files — `assets/claude-plugin`
//! in the repository, `claude-plugin` in the app's resources — and every
//! agent session loads the folder.

use std::path::{Path, PathBuf};

/// The folder's name in the app's resources and under `assets`.
pub const AUTHORING_PLUGIN_DIR: &str = "claude-plugin";

/// The skill folder the app ships (`resources`: the app's resources folder,
/// when it has one), else — in a development checkout — the one in the
/// repository. `None`: agents get no plugin-authoring skill.
pub fn authoring_plugin(resources: Option<&Path>, checkout: Option<&Path>) -> Option<PathBuf> {
    let shipped = resources.map(|dir| dir.join(AUTHORING_PLUGIN_DIR));
    let in_repo = checkout.map(|dir| dir.join("assets").join(AUTHORING_PLUGIN_DIR));
    [shipped, in_repo].into_iter().flatten().find(|dir| dir.join(".claude-plugin/plugin.json").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).expect("the repository").to_owned()
    }

    fn files(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(dir).expect("a folder").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    let relative = path.strip_prefix(root).expect("below the root").to_string_lossy().into_owned();
                    out.push((relative, fs::read(&path).expect("a file")));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    #[test]
    fn the_shipped_folder_wins_and_a_checkout_is_the_fallback() {
        let repo = repo();
        let in_repo = repo.join("assets/claude-plugin");
        assert_eq!(authoring_plugin(None, Some(&repo)), Some(in_repo.clone()));
        assert_eq!(authoring_plugin(None, None), None);

        let resources = tempfile::tempdir().expect("a folder");
        assert_eq!(authoring_plugin(Some(resources.path()), Some(&repo)), Some(in_repo), "nothing shipped there");
        let shipped = resources.path().join("claude-plugin");
        fs::create_dir_all(shipped.join(".claude-plugin")).expect("folders");
        fs::write(shipped.join(".claude-plugin/plugin.json"), "{}").expect("a file");
        assert_eq!(authoring_plugin(Some(resources.path()), Some(&repo)), Some(shipped));
    }

    #[test]
    fn the_skill_is_the_one_the_typescript_tree_ships() {
        let repo = repo();
        let ours = files(&repo.join("assets/claude-plugin"));
        assert!(ours.iter().any(|(name, _)| name == "skills/eos-plugin-authoring/SKILL.md"));
        assert!(ours.iter().any(|(name, _)| name == ".claude-plugin/plugin.json"));
        // Each file as the TypeScript tree shipped it (`fixtures/claude-plugin`).
        let frozen: serde_json::Value = serde_json::from_slice(
            &fs::read(repo.join("fixtures/claude-plugin/files.json")).expect("the frozen hashes"),
        )
        .expect("json");
        let theirs: Vec<(String, String)> = frozen["sha256"]
            .as_object()
            .expect("a map")
            .iter()
            .map(|(name, sha)| (name.clone(), sha.as_str().unwrap_or_default().to_owned()))
            .collect();
        let ours: Vec<(String, String)> = ours.into_iter().map(|(name, bytes)| (name, sha256(&bytes))).collect();
        assert_eq!(ours, theirs, "assets/claude-plugin differs from the TypeScript tree's skill");
    }

    fn sha256(bytes: &[u8]) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }
}
