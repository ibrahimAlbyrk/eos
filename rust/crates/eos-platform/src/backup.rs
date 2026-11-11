//! The startup snapshot (`manager/services/StartupBackupService.ts`): the
//! user-data manifest copied into `<backups>/<stamp>/` before the database is
//! opened, keeping the newest few.
//!
//! In two parts so a snapshot never delays the window:
//! - [`run`](StartupBackup::run), before the database opens (a pending
//!   migration must not run ahead of the copy): everything but the browser profiles;
//! - [`finish`](StartupBackup::finish), once the app is up: browser profiles, then the prune.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::copy::clone_copy_tree;
use crate::paths::USER_DATA_ENTRIES;

/// Thousands of small files: too slow for the window before the app is up.
const DEFERRED_ENTRIES: &[&str] = &["browser"];

/// Chrome rebuilds these on its own; they are most of a profile's size, while
/// the logins worth keeping (cookies, storage) are tiny.
const BROWSER_REGENERABLE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "DawnWebGPUCache",
    "DawnGraphiteCache",
    "GraphiteDawnCache",
    "optimization_guide_model_store",
    "component_crx_cache",
    "WasmTtsEngine",
    "Safe Browsing",
    "OnDeviceHeadSuggestModel",
    "CertificateRevocation",
    "ActorSafetyLists",
    "ZxcvbnData",
];

#[derive(Debug, Clone)]
pub struct StartupBackup {
    home: PathBuf,
    backups_dir: PathBuf,
    keep: usize,
    min_interval: Duration,
}

impl StartupBackup {
    /// Keeps 3 snapshots, and takes none while the newest is younger than an
    /// hour: a burst of restarts must not rotate every older, different snapshot out.
    pub fn new(home: impl Into<PathBuf>, backups_dir: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), backups_dir: backups_dir.into(), keep: 3, min_interval: Duration::from_secs(3600) }
    }

    pub fn keep(mut self, snapshots: usize) -> Self {
        self.keep = snapshots;
        self
    }

    pub fn min_interval(mut self, interval: Duration) -> Self {
        self.min_interval = interval;
        self
    }

    /// Takes the snapshot. Returns its folder for [`finish`](Self::finish), or
    /// `None` when there is nothing to copy or the newest snapshot is recent.
    pub fn run(&self, now: SystemTime) -> io::Result<Option<PathBuf>> {
        let present: Vec<&str> = USER_DATA_ENTRIES.iter().copied().filter(|e| self.home.join(e).exists()).collect();
        if present.is_empty() {
            return Ok(None);
        }
        let now_secs = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        if let Some(taken) = self.snapshots()?.first().and_then(|name| parse_stamp(name))
            // A snapshot stamped after `now` (the clock went back) counts as recent too.
            && Duration::from_secs(now_secs.saturating_sub(taken)) < self.min_interval
        {
            return Ok(None);
        }
        let dst = self.backups_dir.join(stamp(now_secs));
        fs::create_dir_all(&dst)?;
        for entry in present.iter().filter(|e| !DEFERRED_ENTRIES.contains(e)) {
            clone_copy_tree(&self.home.join(entry), &dst.join(entry), &|_| true)?;
        }
        Ok(Some(dst))
    }

    /// Adds the deferred entries to the snapshot `run` returned and prunes old snapshots.
    pub fn finish(&self, snapshot: &Path) -> io::Result<()> {
        for entry in DEFERRED_ENTRIES {
            let src = self.home.join(entry);
            if src.exists() {
                clone_copy_tree(&src, &snapshot.join(entry), &|path| {
                    path.file_name().and_then(|n| n.to_str()).is_none_or(|n| !BROWSER_REGENERABLE_DIRS.contains(&n))
                })?;
            }
        }
        for old in self.snapshots()?.into_iter().skip(self.keep) {
            let _ = fs::remove_dir_all(self.backups_dir.join(old));
        }
        Ok(())
    }

    /// Snapshot folder names, newest first. Anything else in the folder (the
    /// flat `state.db.*.bak` files of old versions) is not ours to prune.
    fn snapshots(&self) -> io::Result<Vec<String>> {
        let entries = match fs::read_dir(&self.backups_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|name| parse_stamp(name).is_some())
            .collect();
        names.sort_unstable_by(|a, b| b.cmp(a));
        Ok(names)
    }
}

/// `YYYY-MM-DDTHH-MM-SS` in UTC: an ISO time a file name can hold.
fn stamp(unix_secs: u64) -> String {
    let (days, rest) = (unix_secs / 86_400, unix_secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}", rest / 3600, rest % 3600 / 60, rest % 60)
}

fn parse_stamp(name: &str) -> Option<u64> {
    let b = name.as_bytes();
    let shape_ok = b.len() == 19
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 | 13 | 16 => *c == b'-',
            10 => *c == b'T',
            _ => c.is_ascii_digit(),
        });
    if !shape_ok {
        return None;
    }
    let num = |range: std::ops::Range<usize>| name[range].parse::<u64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, min, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 || s > 59 {
        return None;
    }
    let days = u64::try_from(days_from_civil(y as i64, m as i64, d as i64)).ok()?;
    Some(days * 86_400 + h * 3600 + min * 60 + s)
}

// Howard Hinnant's civil-date algorithms (proleptic Gregorian, days since 1970-01-01).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-01-01T00:00:00Z
    const START: u64 = 1_767_225_600;

    struct Fixture {
        dir: tempfile::TempDir,
        tick: u64,
    }

    impl Fixture {
        fn new() -> Self {
            Self { dir: tempfile::tempdir().expect("dir"), tick: 0 }
        }
        fn home(&self) -> &Path {
            self.dir.path()
        }
        fn backups(&self) -> PathBuf {
            self.home().join("backups")
        }
        fn service(&self) -> StartupBackup {
            StartupBackup::new(self.home(), self.backups()).keep(5).min_interval(Duration::ZERO)
        }
        /// One second later on every call, as the TypeScript test's clock.
        fn now(&mut self) -> SystemTime {
            self.tick += 1;
            UNIX_EPOCH + Duration::from_secs(START + self.tick - 1)
        }
        fn write(&self, rel: &str, text: &str) {
            let path = self.home().join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
            fs::write(path, text).expect("write");
        }
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(path).expect("read")
    }

    #[test]
    fn stamps_are_utc_and_round_trip() {
        assert_eq!(stamp(START), "2026-01-01T00-00-00");
        assert_eq!(stamp(0), "1970-01-01T00-00-00");
        assert_eq!(stamp(951_782_399), "2000-02-28T23-59-59");
        assert_eq!(stamp(951_782_400), "2000-02-29T00-00-00");
        for secs in [0, START, 951_782_400, 4_102_444_799] {
            assert_eq!(parse_stamp(&stamp(secs)), Some(secs));
        }
        assert_eq!(parse_stamp("state.db.2026-06-01T00-00-00.bak"), None);
        assert_eq!(parse_stamp("2026-13-01T00-00-00"), None);
        assert_eq!(parse_stamp("2026-01-01T00:00:00"), None);
    }

    #[test]
    fn nothing_is_written_when_there_is_no_user_data() {
        let mut f = Fixture::new();
        let now = f.now();
        assert_eq!(f.service().run(now).expect("run"), None);
        assert!(!f.backups().exists());
    }

    #[test]
    fn only_present_manifest_entries_are_copied_folders_whole() {
        let mut f = Fixture::new();
        f.write("state.db", "db");
        f.write("policy.yaml", "default: ask");
        f.write("templates/a.md", "tpl");
        f.write("logs/app.log", "not user data");
        let now = f.now();
        let dst = f.service().run(now).expect("run").expect("a snapshot");
        assert_eq!(dst, f.backups().join("2026-01-01T00-00-00"));
        assert_eq!(read(dst.join("state.db")), "db");
        assert_eq!(read(dst.join("policy.yaml")), "default: ask");
        assert_eq!(read(dst.join("templates/a.md")), "tpl");
        assert!(!dst.join("config.json").exists());
        assert!(!dst.join("logs").exists());
    }

    #[test]
    fn browser_profiles_wait_for_finish_and_lose_their_caches() {
        let mut f = Fixture::new();
        f.write("state.db", "db");
        f.write("browser/profile/Default/Cache/blob", "x");
        f.write("browser/profile/optimization_guide_model_store/model", "x");
        f.write("browser/profile/Default/Cookies", "session");
        let now = f.now();
        let dst = f.service().run(now).expect("run").expect("a snapshot");
        assert_eq!(read(dst.join("state.db")), "db");
        assert!(!dst.join("browser").exists(), "run() stays fast");

        f.service().finish(&dst).expect("finish");
        let copied = dst.join("browser/profile");
        assert_eq!(read(copied.join("Default/Cookies")), "session");
        assert!(!copied.join("Default/Cache").exists());
        assert!(!copied.join("optimization_guide_model_store").exists());
    }

    #[test]
    fn only_the_newest_snapshots_are_kept_and_old_bak_files_are_left_alone() {
        let mut f = Fixture::new();
        f.write("state.db", "db");
        f.write("backups/state.db.2026-06-01T00-00-00.bak", "legacy");
        for _ in 0..7 {
            let now = f.now();
            let dst = f.service().run(now).expect("run").expect("a snapshot");
            f.service().finish(&dst).expect("finish");
        }
        let mut entries: Vec<String> =
            fs::read_dir(f.backups()).expect("list").filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
        entries.sort();
        let snaps: Vec<&String> = entries.iter().filter(|n| !n.ends_with(".bak")).collect();
        assert_eq!(snaps.len(), 5);
        assert!(entries.contains(&"state.db.2026-06-01T00-00-00.bak".to_owned()));
        assert_eq!(snaps.last().map(|s| s.as_str()), Some("2026-01-01T00-00-06"));
        assert_eq!(snaps.first().map(|s| s.as_str()), Some("2026-01-01T00-00-02"));
    }

    #[test]
    fn no_snapshot_while_the_newest_is_younger_than_the_interval() {
        let mut f = Fixture::new();
        f.write("state.db", "db");
        let hourly = StartupBackup::new(f.home(), f.backups());
        let now = f.now();
        assert!(hourly.run(now).expect("run").is_some());
        let now = f.now();
        assert_eq!(hourly.run(now).expect("run"), None);
        f.tick += 3600;
        let now = f.now();
        assert!(hourly.run(now).expect("run").is_some());
    }
}
