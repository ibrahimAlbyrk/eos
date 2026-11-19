//! `cargo xtask sample <copy>`: writes the sample routines
//! (`eos_testkit::routine_seed`) into the `state.db` of a dev data copy, for
//! the dashboard's screens in a dev run. It migrates the file first, as the
//! app would. It refuses the user's own data folder (`~/.eos`, or anything
//! inside it, however the path reaches it) and a folder without `state.db`.
//! A second run on the same copy adds nothing.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use eos_kit_sqlite::{Db, Options};
use eos_store_sqlite::{SqliteStore, StoreOptions};
use eos_testkit::Announced;

pub(crate) fn run(args: &[String]) -> anyhow::Result<()> {
    let Some(copy) = args.first() else { bail!("usage: cargo xtask sample <data copy>") };
    let home = eos_platform::home_dir().context("no home folder")?;
    let db = state_db(Path::new(copy), &home.join(".eos"))?;
    if seed(&db)? {
        println!("sample routines written to {}", db.display());
    } else {
        println!("{} has the sample routines already", db.display());
    }
    Ok(())
}

/// The copy's `state.db`, unless the copy is `user_data` or lies inside it.
fn state_db(copy: &Path, user_data: &Path) -> anyhow::Result<PathBuf> {
    let copy = copy.canonicalize().with_context(|| format!("no folder {}", copy.display()))?;
    let user_data = user_data.canonicalize().unwrap_or_else(|_| user_data.to_owned());
    if copy.starts_with(&user_data) {
        bail!("{} is the user's own data folder: the sample goes into a copy only", copy.display());
    }
    let db = copy.join("state.db");
    if !db.is_file() {
        bail!("{} has no state.db: not a data copy", copy.display());
    }
    Ok(db)
}

/// Migrates the database, then seeds it; false when the sample was there.
fn seed(db: &Path) -> anyhow::Result<bool> {
    let (db, _) = Db::open(db, Options::default(), 0).context("the database does not open")?;
    let store = Arc::new(SqliteStore::new(db, Arc::new(Announced::default()), StoreOptions::default()));
    let runtime = tokio::runtime::Builder::new_current_thread().build()?;
    let port: Arc<dyn eos_core::store::Store> = store;
    Ok(runtime.block_on(eos_testkit::routine_seed::seed(port.as_ref()))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_users_own_data_folder_is_refused_however_it_is_named() {
        let home = tempfile::tempdir().expect("a folder");
        let eos = home.path().join(".eos");
        std::fs::create_dir_all(eos.join("inside")).expect("folders");
        std::fs::write(eos.join("state.db"), b"").expect("a file");
        std::fs::write(eos.join("inside/state.db"), b"").expect("a file");
        let refused = |copy: &Path| state_db(copy, &eos).expect_err("refused").to_string();
        assert!(refused(&eos).contains("user's own data folder"));
        assert!(refused(&eos.join("inside")).contains("user's own data folder"));
        assert!(refused(&home.path().join(".eos/../.eos")).contains("user's own data folder"));
        let link = home.path().join("link");
        std::os::unix::fs::symlink(&eos, &link).expect("a link");
        assert!(refused(&link).contains("user's own data folder"), "a link to it");

        let empty = home.path().join("copy");
        std::fs::create_dir(&empty).expect("a folder");
        assert!(refused(&empty).contains("no state.db"));
        assert!(refused(&home.path().join("missing")).contains("no folder"));
    }

    #[test]
    fn a_copy_is_migrated_and_seeded_once() {
        let home = tempfile::tempdir().expect("a folder");
        let copy = home.path().join("copy");
        std::fs::create_dir(&copy).expect("a folder");
        std::fs::write(copy.join("state.db"), b"").expect("an empty database");
        let db = state_db(&copy, &home.path().join(".eos")).expect("a copy");
        assert!(seed(&db).expect("seeds"));
        assert!(!seed(&db).expect("seeds again"), "nothing the second time");
    }
}
