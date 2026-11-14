//! Unpacks an npm package tarball (`.tgz`) into a folder: plain files and
//! folders only. A link, a path that leaves the folder or a package past the
//! size limits fails the whole unpack — nothing in it is ever run, and no
//! file keeps a mode from the archive. npm puts everything under `package/`;
//! that first segment is dropped.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::MultiGzDecoder;

/// What a plugin package may hold.
#[derive(Debug, Clone, Copy)]
pub struct PackageLimits {
    pub files: u64,
    pub bytes: u64,
}

pub const PACKAGE_LIMITS: PackageLimits = PackageLimits { files: 2000, bytes: 20 * 1024 * 1024 };

const BLOCK: usize = 512;

/// Why a tarball was not unpacked. The text is shown to the user.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct BadPackage(pub String);

fn bad(message: impl Into<String>) -> BadPackage {
    BadPackage(message.into())
}

/// The archive's bytes, refusing one that inflates past twice the size limit
/// (headers and padding included) before more of it is held.
fn gunzip(tgz: &[u8], limits: PackageLimits) -> Result<Vec<u8>, BadPackage> {
    let cap = limits.bytes * 2;
    let mut tar = Vec::new();
    MultiGzDecoder::new(tgz)
        .take(cap + 1)
        .read_to_end(&mut tar)
        .map_err(|e| bad(format!("the package isn't a valid tarball ({e})")))?;
    if tar.len() as u64 > cap {
        return Err(bad(format!("the package unpacks to more than {} MB — too big for a plugin", cap / 1024 / 1024)));
    }
    Ok(tar)
}

/// The text before the first NUL.
fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// A header's size field: octal digits, as JavaScript's `parseInt(text, 8)` reads them.
fn octal(field: &[u8]) -> Result<usize, BadPackage> {
    let text = cstr(field);
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    let digits: String = text.chars().take_while(|c| ('0'..='7').contains(c)).collect();
    usize::from_str_radix(&digits, 8).map_err(|_| bad("the package isn't a valid tarball"))
}

/// One field of a pax extended header (`<len> <key>=<value>\n` records).
fn pax_field(body: &[u8], key: &str) -> Option<String> {
    String::from_utf8_lossy(body).split('\n').find_map(|line| {
        let (len, record) = line.split_once(' ')?;
        let (name, value) = record.split_once('=')?;
        (!len.is_empty() && len.bytes().all(|b| b.is_ascii_digit()) && name == key).then(|| value.to_owned())
    })
}

/// `rel` inside `dir`, or an error: `.` and `..` are resolved by the text, and
/// a path that is absolute or climbs out is refused.
pub fn safe_join(dir: &Path, rel: &str) -> Result<PathBuf, BadPackage> {
    let outside = || bad(format!("the package has a path outside its folder: {rel}"));
    if rel.starts_with('/') {
        return Err(outside());
    }
    let mut kept: Vec<&str> = Vec::new();
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                kept.pop().ok_or_else(outside)?;
            }
            name => kept.push(name),
        }
    }
    Ok(kept.into_iter().fold(dir.to_owned(), |path, segment| path.join(segment)))
}

/// Unpacks `tgz` into `dir`.
pub fn extract_tar_gz(tgz: &[u8], dir: &Path, limits: PackageLimits) -> Result<(), BadPackage> {
    let tar = gunzip(tgz, limits)?;
    let io = |path: &Path, e: std::io::Error| bad(format!("couldn't write {}: {e}", path.display()));
    let mut offset = 0;
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut long_name: Option<String> = None;
    let mut pax_path: Option<String> = None;
    while offset + BLOCK <= tar.len() {
        let header = &tar[offset..offset + BLOCK];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let size = octal(&header[124..136])?;
        let kind = match header[156] {
            0 => b'0',
            other => other,
        };
        let start = offset + BLOCK;
        let body = &tar[start.min(tar.len())..start.saturating_add(size).min(tar.len())];
        offset = start.saturating_add(size.div_ceil(BLOCK).saturating_mul(BLOCK));

        match kind {
            b'L' => {
                long_name = Some(cstr(body));
                continue;
            }
            b'x' => {
                pax_path = pax_field(body, "path");
                continue;
            }
            b'g' => continue,
            _ => {}
        }

        let prefix = cstr(&header[345..500]);
        let short = cstr(&header[..100]);
        let name = pax_path
            .take()
            .or(long_name.take())
            .unwrap_or_else(|| if prefix.is_empty() { short } else { format!("{prefix}/{short}") });
        (long_name, pax_path) = (None, None);

        let rel = name.split_once('/').map_or("", |(_, rest)| rest);
        if kind != b'0' && kind != b'5' {
            return Err(bad(format!("the package holds a link or special file ({name}) — not allowed in a plugin")));
        }
        if rel.is_empty() {
            continue;
        }
        let target = safe_join(dir, rel)?;
        if kind == b'5' {
            fs::create_dir_all(&target).map_err(|e| io(&target, e))?;
            continue;
        }
        files += 1;
        bytes += size as u64;
        if files > limits.files || bytes > limits.bytes {
            return Err(bad(format!(
                "the package is too big for a plugin (over {} files or {} MB)",
                limits.files,
                limits.bytes / 1024 / 1024
            )));
        }
        if target == dir {
            return Err(bad(format!("the package has a path outside its folder: {rel}")));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
        }
        fs::write(&target, body).map_err(|e| io(&target, e))?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod testing {
    use std::io::Write;

    /// A ustar archive, gzipped: `(name, type, body)` with type `'0'` file,
    /// `'5'` folder, `'2'` link — the builder of `infra`'s plugin-install test.
    pub(crate) fn tgz(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, kind, body) in entries {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[100..108].copy_from_slice(b"0000644\0");
            header[124..136].copy_from_slice(format!("{:011o}\0", body.len()).as_bytes());
            header[148..156].copy_from_slice(b"        ");
            header[156] = *kind;
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            tar.extend_from_slice(&header);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(512) * 512, 0);
        }
        tar.resize(tar.len() + 1024, 0);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar).expect("gzip");
        encoder.finish().expect("gzip")
    }
}

#[cfg(test)]
mod tests {
    use super::testing::tgz;
    use super::*;

    const MANIFEST: &[u8] = br#"{"id":"clock","name":"Clock","version":"1.2.0"}"#;

    fn unpack(entries: &[(&str, u8, &[u8])], dir: &Path) -> Result<(), BadPackage> {
        extract_tar_gz(&tgz(entries), dir, PACKAGE_LIMITS)
    }

    fn message(result: Result<(), BadPackage>) -> String {
        result.expect_err("refused").0
    }

    #[test]
    fn unpacks_files_and_folders_under_package() {
        let dir = tempfile::tempdir().expect("a folder");
        unpack(
            &[
                ("package/", b'5', b""),
                ("package/plugin.json", b'0', MANIFEST),
                ("package/src/ui.jsx", b'0', b"export default 1"),
            ],
            dir.path(),
        )
        .expect("unpacks");
        assert_eq!(fs::read(dir.path().join("plugin.json")).expect("the manifest"), MANIFEST);
        assert_eq!(fs::read(dir.path().join("src/ui.jsx")).expect("the entry"), b"export default 1");
    }

    #[test]
    fn refuses_links_and_special_files() {
        for kind in *b"12346" {
            let dir = tempfile::tempdir().expect("a folder");
            let error = message(unpack(&[("package/evil", kind, b"")], dir.path()));
            assert_eq!(error, "the package holds a link or special file (package/evil) — not allowed in a plugin");
            assert_eq!(fs::read_dir(dir.path()).expect("the folder").count(), 0);
        }
    }

    #[test]
    fn a_file_cannot_be_written_through_a_link_the_package_brings() {
        let dir = tempfile::tempdir().expect("a folder");
        let outside = tempfile::tempdir().expect("a folder");
        // The link entry is refused, so nothing after it is written at all.
        let error = message(unpack(&[("package/out", b'2', b""), ("package/out/escape.txt", b'0', b"x")], dir.path()));
        assert!(error.contains("link"), "{error}");
        assert_eq!(fs::read_dir(outside.path()).expect("the folder").count(), 0);
        assert_eq!(fs::read_dir(dir.path()).expect("the folder").count(), 0);
    }

    #[test]
    fn refuses_paths_that_leave_the_folder() {
        let root = tempfile::tempdir().expect("a folder");
        let dir = root.path().join("in");
        for name in ["package/../../escape.txt", "package/a/../../escape.txt", "package//etc/escape.txt", "package/.."]
        {
            let error = message(unpack(&[(name, b'0', b"x")], &dir));
            assert!(error.starts_with("the package has a path outside its folder: "), "{name}: {error}");
        }
        assert!(!root.path().join("escape.txt").exists());
        assert_eq!(safe_join(&dir, "a/./b/../c").expect("inside"), dir.join("a/c"));
        assert!(safe_join(&dir, "/etc/passwd").is_err());
        assert!(safe_join(&dir, "a/../..").is_err());
    }

    #[test]
    fn a_long_name_or_a_pax_path_is_checked_like_any_other() {
        let root = tempfile::tempdir().expect("a folder");
        let dir = root.path().join("in");
        let long = b"package/../../escape.txt\0";
        let error = message(unpack(&[("././@LongLink", b'L', long), ("package/short", b'0', b"x")], &dir));
        assert!(error.contains("outside its folder"), "{error}");
        let pax = b"36 path=package/../../escape.txt\n";
        let error = message(unpack(&[("PaxHeader", b'x', pax), ("package/short", b'0', b"x")], &dir));
        assert!(error.contains("outside its folder"), "{error}");
        assert!(!root.path().join("escape.txt").exists());

        let fine = b"30 path=package/deep/name.txt\n";
        unpack(&[("PaxHeader", b'x', fine), ("package/short", b'0', b"x")], &dir).expect("unpacks");
        assert_eq!(fs::read(dir.join("deep/name.txt")).expect("the file"), b"x");
    }

    #[test]
    fn refuses_a_package_past_the_limits() {
        let dir = tempfile::tempdir().expect("a folder");
        let limits = PackageLimits { files: 2, bytes: 1024 * 1024 };
        let many = tgz(&[("package/a", b'0', b"1"), ("package/b", b'0', b"2"), ("package/c", b'0', b"3")]);
        assert_eq!(
            extract_tar_gz(&many, dir.path(), limits).expect_err("too many").0,
            "the package is too big for a plugin (over 2 files or 1 MB)"
        );
        assert!(!dir.path().join("c").exists(), "the file past the limit is not written");

        let dir = tempfile::tempdir().expect("a folder");
        let limits = PackageLimits { files: 10, bytes: 4096 };
        let body = vec![b'x'; 3000];
        let big = tgz(&[("package/a", b'0', &body), ("package/b", b'0', &body)]);
        assert!(extract_tar_gz(&big, dir.path(), limits).expect_err("too big").0.starts_with("the package is too big"));
        assert!(dir.path().join("a").exists() && !dir.path().join("b").exists());
    }

    #[test]
    fn a_small_archive_that_inflates_without_end_is_stopped() {
        let dir = tempfile::tempdir().expect("a folder");
        let limits = PackageLimits { files: 10, bytes: 1024 };
        let zeros = vec![0u8; 64 * 1024];
        let bomb = tgz(&[("package/zeros", b'0', &zeros)]);
        assert!(bomb.len() < 1024, "compresses well");
        let error = extract_tar_gz(&bomb, dir.path(), limits).expect_err("refused").0;
        assert_eq!(error, "the package unpacks to more than 0 MB — too big for a plugin");
        assert_eq!(fs::read_dir(dir.path()).expect("the folder").count(), 0);
    }

    #[test]
    fn what_is_not_a_tarball_is_refused() {
        let dir = tempfile::tempdir().expect("a folder");
        assert!(
            extract_tar_gz(b"not gzip", dir.path(), PACKAGE_LIMITS)
                .expect_err("refused")
                .0
                .starts_with("the package isn't a valid tarball")
        );
        assert_eq!(octal(b"zzz\0"), Err(bad("the package isn't a valid tarball")));
        assert_eq!(octal(b"00000000017\0"), Ok(15));
        assert_eq!(octal(b"\0\0\0"), Ok(0));
    }

    #[cfg(unix)]
    #[test]
    fn no_file_keeps_a_mode_from_the_archive() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("a folder");
        let mut archive = Vec::new();
        {
            // The same entry builder, with the mode field saying "executable".
            let mut tar = Vec::new();
            let mut header = [0u8; 512];
            header[..18].copy_from_slice(b"package/install.sh");
            header[100..108].copy_from_slice(b"0000755\0");
            header[124..136].copy_from_slice(b"00000000002\0");
            header[156] = b'0';
            tar.extend_from_slice(&header);
            tar.extend_from_slice(b"hi");
            tar.resize(2048, 0);
            use std::io::Write;
            let mut encoder = flate2::write::GzEncoder::new(&mut archive, flate2::Compression::default());
            encoder.write_all(&tar).expect("gzip");
            encoder.finish().expect("gzip");
        }
        extract_tar_gz(&archive, dir.path(), PACKAGE_LIMITS).expect("unpacks");
        let mode = fs::metadata(dir.path().join("install.sh")).expect("the file").permissions().mode();
        assert_eq!(mode & 0o111, 0, "not executable");
    }
}
