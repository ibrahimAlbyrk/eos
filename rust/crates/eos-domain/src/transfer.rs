//! Pure rules of a file transfer between computers
//! (`core/src/domain/transfer.ts`): which paths are safe, what a "Keep both"
//! copy is called, how big a chunk is, how fast it is going, and which paired
//! computer a name means. The engine and both endpoint adapters share them.

use eos_contracts::{
    ManifestItem, ManifestItemType, TransferConflict, TransferConflictExisting, TransferConflictIncoming,
    TransferErrorCode, TransferExisting, TransferRoot, TransferRoute,
};
use indexmap::IndexMap;

use crate::text::js_trim;

/// Why an endpoint or the engine did not do what it was asked. `code` is
/// what the other computer and the dashboard act on; `None` is a failure
/// nobody classified (a disk error), which the routes answer as a 500.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferError {
    pub code: Option<TransferErrorCode>,
    pub message: String,
    /// `offset-mismatch`: how many bytes the receiving side already holds.
    pub have: Option<u64>,
}

impl TransferError {
    pub fn new(code: TransferErrorCode, message: impl Into<String>) -> Self {
        Self { code: Some(code), message: message.into(), have: None }
    }

    pub fn offset_mismatch(message: impl Into<String>, have: u64) -> Self {
        Self { code: Some(TransferErrorCode::OffsetMismatch), message: message.into(), have: Some(have) }
    }

    /// A failure with no code of its own.
    pub fn failed(cause: impl std::fmt::Display) -> Self {
        Self { code: None, message: cause.to_string(), have: None }
    }

    pub fn is(&self, code: TransferErrorCode) -> bool {
        self.code == Some(code)
    }

    /// Worth waiting out: the link dropped, the other computer is waking up.
    pub fn is_transient(&self) -> bool {
        self.is(TransferErrorCode::Unreachable)
    }

    /// The code as a transfer record carries it (`offset-mismatch`; `failed`
    /// when there is none).
    pub fn code_name(&self) -> &'static str {
        self.code.map_or("failed", code_name)
    }

    /// The status a `/transfer/*` route answers this with.
    pub fn status(&self) -> u16 {
        self.code.map_or(500, error_status)
    }
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransferError {}

/// An absolute path without a NUL, as every endpoint call needs it.
pub fn check_absolute(path: &str) -> Result<(), TransferError> {
    if path.starts_with('/') && !path.contains('\0') {
        Ok(())
    } else {
        Err(TransferError::new(TransferErrorCode::BadPath, "an absolute path is required"))
    }
}

/// `^tr-[a-z0-9]{8,32}$`
pub fn is_transfer_id(id: &str) -> bool {
    id.strip_prefix("tr-").is_some_and(|rest| {
        (8..=32).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

pub fn code_name(code: TransferErrorCode) -> &'static str {
    match code {
        TransferErrorCode::BadPath => "bad-path",
        TransferErrorCode::NotFound => "not-found",
        TransferErrorCode::ForbiddenDest => "forbidden-dest",
        TransferErrorCode::DuplicateName => "duplicate-name",
        TransferErrorCode::TooMany => "too-many",
        TransferErrorCode::SourceChanged => "source-changed",
        TransferErrorCode::OffsetMismatch => "offset-mismatch",
        TransferErrorCode::NoSpace => "no-space",
        TransferErrorCode::ConflictUnresolved => "conflict-unresolved",
        TransferErrorCode::Incomplete => "incomplete",
        TransferErrorCode::Unreachable => "unreachable",
        TransferErrorCode::NeedsUpdate => "needs-update",
        TransferErrorCode::Forbidden => "forbidden",
    }
}

/// The status a `/transfer/*` route answers a refusal with.
pub fn error_status(code: TransferErrorCode) -> u16 {
    match code {
        TransferErrorCode::BadPath => 400,
        TransferErrorCode::NotFound => 404,
        TransferErrorCode::ForbiddenDest | TransferErrorCode::Forbidden => 403,
        TransferErrorCode::DuplicateName
        | TransferErrorCode::OffsetMismatch
        | TransferErrorCode::ConflictUnresolved
        | TransferErrorCode::Incomplete => 409,
        TransferErrorCode::TooMany => 413,
        TransferErrorCode::SourceChanged => 412,
        TransferErrorCode::NoSpace => 507,
        TransferErrorCode::Unreachable => 502,
        TransferErrorCode::NeedsUpdate => 501,
    }
}

/// A manifest path's segments, or `None` when it could land outside its folder.
pub fn rel_segments(rel: &str) -> Option<Vec<&str>> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        return None;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") { None } else { Some(parts) }
}

/// The first segment of a manifest path: the picked item it sits under.
pub fn root_of(rel: &str) -> &str {
    rel.split('/').next().unwrap_or(rel)
}

pub fn base_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rfind('/').map_or(trimmed, |i| &trimmed[i + 1..])
}

pub fn parent_dir(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(i) if i > 0 => &trimmed[..i],
        _ => "/",
    }
}

pub fn join_path(dir: &str, rel: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{rel}") } else { format!("{dir}/{rel}") }
}

/// The folder the picked items share: it decides "the same project" on the
/// other computer.
pub fn common_parent<S: AsRef<str>>(paths: &[S]) -> String {
    let mut dirs = paths.iter().map(|p| parent_dir(p.as_ref()).split('/').collect::<Vec<_>>());
    let mut common = dirs.next().unwrap_or_else(|| vec![""]);
    for dir in dirs {
        let shared = common.iter().zip(&dir).take_while(|(a, b)| a == b).count();
        common.truncate(shared);
    }
    let joined = common.join("/");
    if joined.is_empty() { "/".to_owned() } else { joined }
}

/// Finder's Keep Both: `Report.pdf` → `Report 2.pdf`, `NeonDrift.app` →
/// `NeonDrift 2.app`.
pub fn keep_both_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let mut n = 2u64;
    loop {
        let candidate = format!("{stem} {n}{ext}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The selected items (a path without `/`) with the bytes under each.
pub fn manifest_roots(items: &[ManifestItem]) -> Vec<TransferRoot> {
    let mut roots: IndexMap<&str, TransferRoot> = IndexMap::new();
    for item in items.iter().filter(|i| !i.rel.contains('/')) {
        roots.insert(
            &item.rel,
            TransferRoot { name: item.rel.clone(), r#type: item.r#type, size: 0, mtime_ms: item.mtime_ms },
        );
    }
    for item in items.iter().filter(|i| i.r#type == ManifestItemType::File) {
        if let Some(root) = roots.get_mut(root_of(&item.rel)) {
            root.size += item.size;
        }
    }
    roots.into_values().collect()
}

/// What already sits where a picked item would land, paired with what is coming.
pub fn conflicts_of(roots: &[TransferRoot], existing: &[TransferExisting]) -> Vec<TransferConflict> {
    existing
        .iter()
        .filter_map(|there| {
            let coming = roots.iter().rev().find(|r| r.name == there.name)?;
            Some(TransferConflict {
                name: there.name.clone(),
                existing: TransferConflictExisting { r#type: there.r#type, size: there.size, mtime_ms: there.mtime_ms },
                incoming: TransferConflictIncoming {
                    r#type: coming.r#type,
                    size: coming.size,
                    mtime_ms: coming.mtime_ms,
                },
            })
        })
        .collect()
}

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
pub const MIN_CHUNK: u64 = 256 * KIB;

/// (first chunk, largest chunk) of a route.
fn chunk_bounds(route: Option<TransferRoute>) -> (u64, u64) {
    match route {
        Some(TransferRoute::Local) => (16 * MIB, 16 * MIB),
        Some(TransferRoute::Direct) => (4 * MIB, 16 * MIB),
        Some(TransferRoute::Relay | TransferRoute::Reverse) | None => (MIB, 4 * MIB),
    }
}

/// About a second of what the link is doing, so every request stays short: a
/// long upload would hit the servers' request timeout, and a deep queue on a
/// slow relay would starve the link's liveness ping.
pub fn chunk_length(route: Option<TransferRoute>, rate: f64) -> u64 {
    let (first, max) = chunk_bounds(route);
    if rate <= 0.0 {
        return first;
    }
    // `rate` is finite and positive; the clamp keeps the cast in range.
    (rate.round().min(max as f64) as u64).max(MIN_CHUNK)
}

/// Files in flight at once: fewer where every byte crosses the relay.
pub fn file_concurrency(route: Option<TransferRoute>) -> usize {
    match route {
        Some(TransferRoute::Local | TransferRoute::Direct) => 4,
        _ => 2,
    }
}

/// Bytes per second, smoothed over half-second windows. Time is given by the
/// caller, in epoch milliseconds.
#[derive(Debug, Clone)]
pub struct RateMeter {
    window_start: i64,
    bytes: u64,
    value: f64,
}

impl RateMeter {
    pub fn new(now_ms: i64) -> Self {
        Self { window_start: now_ms, bytes: 0, value: 0.0 }
    }

    pub fn add(&mut self, bytes: u64, now_ms: i64) {
        self.bytes += bytes;
        self.tick(now_ms);
    }

    pub fn rate(&mut self, now_ms: i64) -> f64 {
        self.tick(now_ms);
        self.value
    }

    fn tick(&mut self, now_ms: i64) {
        let dt = now_ms - self.window_start;
        if dt < 500 {
            return;
        }
        let instant = self.bytes as f64 * 1000.0 / dt as f64;
        self.value = if self.value == 0.0 { instant } else { self.value * 0.6 + instant * 0.4 };
        self.bytes = 0;
        self.window_start = now_ms;
    }
}

/// `1.3 KB`, `12 MB`: one decimal below ten, none above, as JavaScript's
/// `toFixed` rounds (a half goes up).
pub fn format_bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut value = n as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 {
        format!("{:.1} {}", (value * 10.0 + 0.5).floor() / 10.0, UNITS[unit])
    } else {
        format!("{:.0} {}", (value + 0.5).floor(), UNITS[unit])
    }
}

/// A paired computer and the names it goes by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineName {
    pub id: String,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineMatch {
    One(String),
    None,
    Many(Vec<String>),
}

fn normalize_name(name: &str) -> String {
    let lowered: String = name.to_lowercase().chars().filter(|c| !matches!(c, '’' | '\'')).collect();
    let mut out = String::with_capacity(lowered.len());
    let mut in_space = false;
    for c in lowered.chars() {
        if crate::text::is_js_space(c) {
            in_space = true;
        } else {
            if in_space && !out.is_empty() {
                out.push(' ');
            }
            in_space = false;
            out.push(c);
        }
    }
    js_trim(&out).to_owned()
}

/// "macbook air", "Air", "the MacBook Air" → one paired computer. Exact name
/// first, then a unique prefix or substring match; never a guess between two.
pub fn match_machine(query: &str, machines: &[MachineName]) -> MachineMatch {
    let normalized = normalize_name(query);
    let q = normalized.strip_prefix("the ").or_else(|| normalized.strip_prefix("my ")).unwrap_or(&normalized);
    if q.is_empty() {
        return MachineMatch::None;
    }
    let tests: [&dyn Fn(&str) -> bool; 3] = [&|n| n == q, &|n| n.starts_with(q), &|n| n.contains(q)];
    for test in tests {
        let ids: Vec<String> = machines
            .iter()
            .filter(|m| m.names.iter().any(|n| test(&normalize_name(n))))
            .map(|m| m.id.clone())
            .fold(Vec::new(), |mut ids, id| {
                if !ids.contains(&id) {
                    ids.push(id);
                }
                ids
            });
        match ids.len() {
            0 => {}
            1 => return MachineMatch::One(ids.into_iter().next().unwrap_or_default()),
            _ => return MachineMatch::Many(ids),
        }
    }
    MachineMatch::None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use eos_contracts::Num;

    use super::*;

    fn item(rel: &str, kind: ManifestItemType, size: i64, mtime: f64, mode: i64) -> ManifestItem {
        ManifestItem { rel: rel.to_owned(), r#type: kind, size, mtime_ms: Num(mtime), mode, target: None }
    }

    // core/src/__tests__/transfer.test.ts, "transfer rules".

    #[test]
    fn refuses_manifest_paths_that_could_leave_their_folder() {
        assert_eq!(rel_segments("app/Contents/Info.plist"), Some(vec!["app", "Contents", "Info.plist"]));
        for bad in ["", "/etc/passwd", "a/../b", "../x", "a//b", "./a", "a/\0"] {
            assert_eq!(rel_segments(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn names_a_keep_both_copy_the_way_finder_does() {
        assert_eq!(keep_both_name("Report.pdf", |n| n == "Report 2.pdf"), "Report 3.pdf");
        assert_eq!(keep_both_name("NeonDrift.app", |_| false), "NeonDrift 2.app");
        assert_eq!(keep_both_name(".env", |_| false), ".env 2");
        assert_eq!(keep_both_name("builds", |_| false), "builds 2");
    }

    #[test]
    fn finds_the_folder_picked_items_share() {
        assert_eq!(common_parent(&["/p/neon/builds/a.zip", "/p/neon/builds/B.app"]), "/p/neon/builds");
        assert_eq!(common_parent(&["/p/neon/builds/a.zip", "/p/neon/assets"]), "/p/neon");
        assert_eq!(common_parent(&["/a/x", "/b/y"]), "/");
    }

    #[test]
    fn totals_each_root_and_pairs_conflicts_with_what_is_coming() {
        let items = [
            item("game", ManifestItemType::Dir, 0, 5.0, 0o755),
            item("game/a", ManifestItemType::File, 10, 6.0, 0o644),
            item("game/b", ManifestItemType::File, 5, 6.0, 0o644),
            item("x.zip", ManifestItemType::File, 7, 9.0, 0o644),
        ];
        let roots = manifest_roots(&items);
        let sizes: Vec<(&str, i64)> = roots.iter().map(|r| (r.name.as_str(), r.size)).collect();
        assert_eq!(sizes, [("game", 15), ("x.zip", 7)]);
        let there = TransferExisting {
            name: "x.zip".into(),
            r#type: ManifestItemType::File,
            size: Some(3),
            mtime_ms: Num(1.0),
        };
        let conflicts = conflicts_of(&roots, &[there]);
        assert_eq!(
            serde_json::to_value(&conflicts).unwrap(),
            serde_json::json!([{ "name": "x.zip", "existing": { "type": "file", "size": 3, "mtimeMs": 1 }, "incoming": { "type": "file", "size": 7, "mtimeMs": 9 } }])
        );
    }

    #[test]
    fn sizes_a_chunk_to_about_a_second_of_the_link_within_its_routes_bounds() {
        assert_eq!(chunk_length(Some(TransferRoute::Relay), 0.0), 1024 * 1024);
        assert_eq!(chunk_length(Some(TransferRoute::Relay), 100.0 * 1024.0 * 1024.0), 4 * 1024 * 1024);
        assert_eq!(chunk_length(Some(TransferRoute::Direct), 1000.0), MIN_CHUNK);
        assert_eq!(chunk_length(Some(TransferRoute::Direct), 9_000_000.0), 9_000_000);
        assert_eq!(chunk_length(None, 0.0), 1024 * 1024);
        assert_eq!(chunk_length(Some(TransferRoute::Local), 0.0), 16 * 1024 * 1024);
    }

    #[test]
    fn smooths_the_rate_over_half_second_windows() {
        let mut meter = RateMeter::new(0);
        meter.add(1000, 0);
        assert_eq!(meter.rate(0), 0.0);
        meter.add(0, 500);
        assert_eq!(meter.rate(500), 2000.0);
    }

    #[test]
    fn matches_a_computer_the_way_a_person_names_it() {
        let macs = [
            MachineName { id: "air".into(), names: vec!["MacBook Air".into(), "Ibrahim's MacBook Air".into()] },
            MachineName { id: "pro".into(), names: vec!["MacBook Pro".into()] },
            MachineName { id: "mini".into(), names: vec!["Office".into(), "Mac mini".into()] },
        ];
        assert_eq!(match_machine("macbook air", &macs), MachineMatch::One("air".into()));
        assert_eq!(match_machine("my MacBook Air", &macs), MachineMatch::One("air".into()));
        assert_eq!(match_machine("mini", &macs), MachineMatch::One("mini".into()));
        assert_eq!(match_machine("office", &macs), MachineMatch::One("mini".into()));
        assert_eq!(match_machine("macbook", &macs), MachineMatch::Many(vec!["air".into(), "pro".into()]));
        assert_eq!(match_machine("iMac", &macs), MachineMatch::None);
        assert_eq!(match_machine("  ", &macs), MachineMatch::None);
    }

    #[test]
    fn bytes_read_as_javascript_formats_them() {
        // `v.toFixed(v < 10 ? 1 : 0)`: a half rounds up, where Rust's own
        // formatting rounds it to even.
        for (n, text) in [
            (0, "0 B"),
            (1023, "1023 B"),
            (1024, "1.0 KB"),
            (1280, "1.3 KB"),
            (1536, "1.5 KB"),
            (10 * 1024, "10 KB"),
            (10752, "11 KB"),
            (1024 * 1024, "1.0 MB"),
            (5 * 1024 * 1024 * 1024, "5.0 GB"),
            (3 * 1024 * 1024 * 1024 * 1024 * 1024, "3072 TB"),
        ] {
            assert_eq!(format_bytes(n), text);
        }
    }

    #[test]
    fn an_error_carries_its_code_its_status_and_what_the_other_side_holds() {
        let refused = TransferError::offset_mismatch("f holds 3 bytes, not 0", 3);
        assert_eq!((refused.code_name(), refused.status(), refused.have), ("offset-mismatch", 409, Some(3)));
        assert!(TransferError::new(TransferErrorCode::Unreachable, "gone").is_transient());
        let disk = TransferError::failed("disk error");
        assert_eq!((disk.code_name(), disk.status(), disk.is_transient()), ("failed", 500, false));
        assert!(check_absolute("/a").is_ok());
        assert!(check_absolute("a").is_err() && check_absolute("/a\0").is_err() && check_absolute("").is_err());
        assert!(is_transfer_id("tr-abcdef123456") && !is_transfer_id("tr-short") && !is_transfer_id("tr-../../etc/x"));
    }

    #[test]
    fn paths_split_and_join_as_today() {
        assert_eq!(base_name("/a/b/c.txt"), "c.txt");
        assert_eq!(base_name("/a/b/"), "b");
        assert_eq!(parent_dir("/a/b/c.txt"), "/a/b");
        assert_eq!(parent_dir("/a"), "/");
        assert_eq!(join_path("/a", "b/c"), "/a/b/c");
        assert_eq!(join_path("/", "b"), "/b");
        assert_eq!(root_of("game/a/b"), "game");
    }
}
