//! Deletes that can be undone by hand: nothing here removes data.

use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::Error;

/// The time as an ISO string a file name can hold: `2026-01-01T09-30-00-125`
/// (UTC, milliseconds, `:` and `.` replaced, no `Z`).
pub fn trash_stamp(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (since.as_secs(), since.subsec_millis());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil-from-days.
    let z = days as i64 + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{millis:03}", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// `<dir>/<name>.<ext>` → `<dir>/.trash/<name>.<stamp>.<ext>`. Returns false
/// when there is no such file.
pub fn move_to_trash(dir: &Path, name: &str, ext: &str, now: SystemTime) -> Result<bool, Error> {
    let path = dir.join(format!("{name}.{ext}"));
    if !path.exists() {
        return Ok(false);
    }
    let trash = dir.join(".trash");
    fs::create_dir_all(&trash).map_err(Error::io(&trash))?;
    fs::rename(&path, trash.join(format!("{name}.{}.{ext}", trash_stamp(now)))).map_err(Error::io(&path))?;
    Ok(true)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Eight hex digits that differ between calls and between processes.
fn short_tag() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    format!("{:08x}", hasher.finish() as u32)
}

/// Moves a file or folder into `trash_dir` as `<tag>-<name>` — the fallback
/// where the system trash is unavailable. The tag keeps same-named deletes
/// apart. Returns where it went.
pub fn trash_into_dir(path: &Path, trash_dir: &Path) -> Result<PathBuf, Error> {
    fs::create_dir_all(trash_dir).map_err(Error::io(trash_dir))?;
    let name = path.file_name().ok_or_else(|| Error::Io {
        path: path.to_owned(),
        source: io::Error::new(io::ErrorKind::InvalidInput, "no file name"),
    })?;
    let dest = loop {
        let mut tagged = std::ffi::OsString::from(format!("{}-", short_tag()));
        tagged.push(name);
        let dest = trash_dir.join(tagged);
        if !dest.exists() {
            break dest;
        }
    };
    match fs::rename(path, &dest) {
        Ok(()) => Ok(dest),
        // The trash is on another filesystem: copy, then remove.
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            copy_tree(path, &dest)?;
            let removed =
                if path.is_dir() && !path.is_symlink() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
            removed.map_err(Error::io(path))?;
            Ok(dest)
        }
        Err(e) => Err(Error::Io { path: path.to_owned(), source: e }),
    }
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), Error> {
    let mut pending = vec![(from.to_owned(), to.to_owned())];
    while let Some((src, dst)) = pending.pop() {
        let kind = fs::symlink_metadata(&src).map_err(Error::io(&src))?.file_type();
        if kind.is_dir() {
            fs::create_dir_all(&dst).map_err(Error::io(&dst))?;
            for entry in fs::read_dir(&src).map_err(Error::io(&src))? {
                let entry = entry.map_err(Error::io(&src))?;
                pending.push((entry.path(), dst.join(entry.file_name())));
            }
        } else if kind.is_file() {
            fs::copy(&src, &dst).map_err(Error::io(&src))?;
        }
        // A link's target may not exist on the other side; links are left behind.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(secs: u64, millis: u32) -> SystemTime {
        UNIX_EPOCH + Duration::new(secs, millis * 1_000_000)
    }

    #[test]
    fn the_stamp_is_the_iso_time_with_dashes() {
        // new Date(Date.UTC(2026, 0, 1, 9, 30, 0, 125)).toISOString() = "2026-01-01T09:30:00.125Z"
        assert_eq!(trash_stamp(at(1_767_259_800, 125)), "2026-01-01T09-30-00-125");
        assert_eq!(trash_stamp(at(0, 0)), "1970-01-01T00-00-00-000");
        assert_eq!(trash_stamp(at(951_782_400, 7)), "2000-02-29T00-00-00-007");
    }

    #[test]
    fn a_trashed_file_keeps_its_name_and_extension_around_the_stamp() {
        let dir = tempfile::tempdir().expect("dir");
        fs::write(dir.path().join("p_abc.md"), "page").expect("write");
        assert!(move_to_trash(dir.path(), "p_abc", "md", at(1_767_259_800, 125)).expect("trash"));
        assert!(!dir.path().join("p_abc.md").exists());
        let kept = dir.path().join(".trash/p_abc.2026-01-01T09-30-00-125.md");
        assert_eq!(fs::read_to_string(kept).expect("read"), "page");
        assert!(!move_to_trash(dir.path(), "p_abc", "md", at(1_767_259_801, 0)).expect("missing is a no-op"));
    }

    #[test]
    fn the_fallback_trash_keeps_same_named_deletes_apart() {
        let dir = tempfile::tempdir().expect("dir");
        let trash = dir.path().join(".eos-trash");
        let mut kept = Vec::new();
        for round in 0..2 {
            let folder = dir.path().join("project");
            fs::create_dir_all(folder.join("src")).expect("dirs");
            fs::write(folder.join("src/a.txt"), round.to_string()).expect("write");
            kept.push(trash_into_dir(&folder, &trash).expect("trash"));
            assert!(!folder.exists());
        }
        assert_ne!(kept[0], kept[1]);
        for (round, dest) in kept.iter().enumerate() {
            let name = dest.file_name().and_then(|n| n.to_str()).expect("name");
            assert_eq!(&name[8..], "-project");
            assert!(name[..8].chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(fs::read_to_string(dest.join("src/a.txt")).expect("read"), round.to_string());
        }
        assert!(trash_into_dir(&dir.path().join("gone"), &trash).expect_err("missing").is_not_found());
    }
}
