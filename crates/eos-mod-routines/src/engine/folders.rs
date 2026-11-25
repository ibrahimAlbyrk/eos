//! A blueprint's folder triggers against the folder limits (02 §10): a
//! folder that holds more than [`FOLDER_ENTRIES_MAX`] entries, or one more
//! folder than [`FOLDERS_MAX`] watched at once, is refused when the version
//! is saved, as the folder source would refuse it at run time.

use std::collections::BTreeSet;
use std::path::Path;

use eos_contracts::{Blueprint, BlueprintIssue, IssueSeverity, RoutineState, Trigger};
use eos_core::Error;
use eos_core::os::ListDirOptions;
use eos_core::store::Tx;
use eos_domain::signals::limits::{FOLDER_ENTRIES_MAX, FOLDERS_MAX};

use super::Engine;
use crate::routes::{readable, showing_version};

fn folder_paths(blueprint: &Blueprint) -> impl Iterator<Item = (usize, &str)> {
    blueprint.when.on.iter().enumerate().filter_map(|(i, trigger)| match trigger {
        Trigger::Folder { folder, .. } => Some((i, folder.path.as_str())),
        _ => None,
    })
}

fn issue(at: usize, message: String) -> BlueprintIssue {
    let path = ["when".to_owned(), "on".to_owned(), at.to_string(), "folder".to_owned(), "path".to_owned()].into();
    BlueprintIssue { path, message, severity: IssueSeverity::Error }
}

/// The folders that hold too many entries now. A folder that cannot be
/// listed is left to the source, which says why at run time.
pub(crate) async fn crowded(engine: &Engine, blueprint: &Blueprint) -> Vec<BlueprintIssue> {
    let mut issues = Vec::new();
    for (at, path) in folder_paths(blueprint) {
        let dir = Path::new(path);
        if !dir.is_absolute() {
            continue;
        }
        let options = ListDirOptions { root: dir, include_hidden: false, apply_ignore: false };
        if engine.trash.list_dir(dir, options).await.is_ok_and(|entries| entries.len() > FOLDER_ENTRIES_MAX) {
            issues.push(issue(at, format!("Holds more than {FOLDER_ENTRIES_MAX} entries")));
        }
    }
    issues
}

/// The folders of `blueprint` that would watch more than [`FOLDERS_MAX`]
/// folders at once with the active routines' other than `routine_id`.
pub(crate) fn too_many(tx: &dyn Tx, routine_id: &str, blueprint: &Blueprint) -> Result<Vec<BlueprintIssue>, Error> {
    let mut watched = BTreeSet::new();
    for routine in tx.routines().list()? {
        if routine.id == routine_id || routine.state != RoutineState::Active {
            continue;
        }
        let Some(other) = showing_version(tx, &routine.id)?.map(|version| readable(&version)).transpose()?.flatten()
        else {
            continue;
        };
        watched.extend(folder_paths(&other).map(|(_, path)| path.to_owned()));
    }
    let mut issues = Vec::new();
    for (at, path) in folder_paths(blueprint) {
        if watched.insert(path.to_owned()) && watched.len() > FOLDERS_MAX {
            issues.push(issue(at, format!("Would watch more than {FOLDERS_MAX} folders at once")));
        }
    }
    Ok(issues)
}
