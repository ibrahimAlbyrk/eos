//! Reads an app bundle the way the update feed describes it: every directory,
//! link and file in path order, each file hashed whole and — when asked — cut
//! into content-defined chunks with their own hashes. The publisher builds a
//! release's manifest from it; the installed app indexes itself with it; a
//! staged copy is checked with it. One reader, so all three see the same tree.
//!
//! Synchronous and heavy (it reads every byte): call it from a blocking thread.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use eos_domain::update::ContentChunker;
use sha2::{Digest, Sha256};

const READ_SLICE: usize = 4 * 1024 * 1024;

/// One chunk of a scanned file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedChunk {
    /// sha256 of the chunk's bytes, lowercase hex.
    pub id: String,
    pub offset: i64,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScannedEntry {
    Dir { path: String, mode: i64 },
    Link { path: String, target: String },
    File { path: String, mode: i64, size: i64, sha256: String, chunks: Vec<ScannedChunk> },
}

impl ScannedEntry {
    pub fn path(&self) -> &str {
        match self {
            Self::Dir { path, .. } | Self::Link { path, .. } | Self::File { path, .. } => path,
        }
    }
}

pub(crate) fn hex(digest: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 15)] as char);
    }
    out
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// The whole tree under `root`, in the order the publisher lists it. With
/// `chunks` off, files are only hashed whole (their chunk lists stay empty).
pub fn scan_bundle(root: &Path, chunks: bool) -> io::Result<Vec<ScannedEntry>> {
    let mut entries = Vec::new();
    let mut buf = vec![0u8; READ_SLICE];
    walk(root, "", &mut entries, chunks, &mut buf)?;
    Ok(entries)
}

fn other(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn walk(root: &Path, rel: &str, out: &mut Vec<ScannedEntry>, chunks: bool, buf: &mut [u8]) -> io::Result<()> {
    let dir = if rel.is_empty() { root.to_owned() } else { root.join(rel) };
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let name = entry?.file_name();
        let name =
            name.into_string().map_err(|n| other(format!("{rel}/{}: a name that is not text", n.to_string_lossy())))?;
        names.push(name);
    }
    // JavaScript's `sort()`: by UTF-16 code units, which is not byte order
    // once a name holds a character outside the BMP.
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for name in names {
        let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let abs = root.join(&path);
        let meta = fs::symlink_metadata(&abs)?;
        let kind = meta.file_type();
        if kind.is_symlink() {
            let target = fs::read_link(&abs)?;
            let target = target
                .into_os_string()
                .into_string()
                .map_err(|_| other(format!("{path}: a link target that is not text")))?;
            out.push(ScannedEntry::Link { path, target });
        } else if kind.is_dir() {
            out.push(ScannedEntry::Dir { path: path.clone(), mode: crate::fsx::mode_of(&meta) });
            walk(root, &path, out, chunks, buf)?;
        } else if kind.is_file() {
            let (size, sha256, file_chunks) = read_file(&abs, chunks, buf)?;
            out.push(ScannedEntry::File { path, mode: crate::fsx::mode_of(&meta), size, sha256, chunks: file_chunks });
        } else {
            return Err(other(format!("{path}: not a file, folder or link")));
        }
    }
    Ok(())
}

fn read_file(abs: &Path, with_chunks: bool, buf: &mut [u8]) -> io::Result<(i64, String, Vec<ScannedChunk>)> {
    let mut whole = Sha256::new();
    let mut chunks = Vec::new();
    let mut chunker = ContentChunker::new();
    let mut piece = Sha256::new();
    // Bytes of the chunk in progress already fed to `piece` from earlier slices.
    let mut pending = 0usize;
    let mut offset = 0i64;
    let mut size = 0i64;
    let mut cuts = Vec::new();
    let mut close = |piece: &mut Sha256, length: usize| {
        let length = length as i64;
        chunks.push(ScannedChunk { id: hex(&piece.finalize_reset()), offset, size: length });
        offset += length;
    };

    let mut file = File::open(abs)?;
    loop {
        let read = file.read(buf)?;
        if read == 0 {
            break;
        }
        let slice = &buf[..read];
        size += read as i64;
        whole.update(slice);
        if !with_chunks {
            continue;
        }
        cuts.clear();
        chunker.push(slice, &mut cuts);
        let mut at = 0usize;
        for &length in &cuts {
            let take = length - pending;
            piece.update(&slice[at..at + take]);
            at += take;
            pending = 0;
            close(&mut piece, length);
        }
        piece.update(&slice[at..]);
        pending += slice.len() - at;
    }
    if with_chunks && let Some(last) = chunker.end() {
        close(&mut piece, last);
    }
    Ok((size, hex(&whole.finalize()), chunks))
}

#[cfg(test)]
mod tests {
    use eos_domain::update::chunk_lengths;

    use super::*;

    #[test]
    fn a_file_read_in_slices_is_cut_as_one_buffer_would_be() {
        let dir = tempfile::tempdir().expect("dir");
        let data = eos_testkit::update::noise(700_000, 1);
        fs::write(dir.path().join("big.bin"), &data).expect("write");
        // A buffer far smaller than a chunk: every chunk spans several reads.
        let mut small = vec![0u8; 4096];
        let (size, sha, chunks) = read_file(&dir.path().join("big.bin"), true, &mut small).expect("read");
        assert_eq!((size, sha), (700_000, sha256_hex(&data)));
        let mut at = 0usize;
        for (chunk, length) in chunks.iter().zip(chunk_lengths(&data)) {
            assert_eq!((chunk.offset as usize, chunk.size as usize), (at, length));
            assert_eq!(chunk.id, sha256_hex(&data[at..at + length]));
            at += length;
        }
        assert_eq!(at, 700_000);
        assert!(chunks.len() > 1);
    }

    #[cfg(unix)]
    #[test]
    fn every_entry_is_listed_in_javascript_sort_order() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().join("A.app");
        fs::create_dir_all(root.join("Contents")).expect("dirs");
        fs::write(root.join("Contents/big.bin"), eos_testkit::update::noise(700_000, 1)).expect("write");
        fs::write(root.join("Contents/x"), "hi").expect("write");
        fs::set_permissions(root.join("Contents/x"), fs::Permissions::from_mode(0o755)).expect("mode");
        std::os::unix::fs::symlink("x", root.join("Contents/link")).expect("link");
        // U+FF5E sorts before U+1F600 by code point, after it by UTF-16 unit.
        fs::write(root.join("Contents/\u{ff5e}"), "").expect("write");
        fs::write(root.join("Contents/\u{1f600}"), "").expect("write");

        let entries = scan_bundle(&root, true).expect("scan");
        let listed: Vec<String> = entries
            .iter()
            .map(|e| match e {
                ScannedEntry::Dir { path, .. } => format!("dir:{path}"),
                ScannedEntry::Link { path, target } => format!("link:{path}->{target}"),
                ScannedEntry::File { path, .. } => format!("file:{path}"),
            })
            .collect();
        assert_eq!(
            listed,
            [
                "dir:Contents",
                "file:Contents/big.bin",
                "link:Contents/link->x",
                "file:Contents/x",
                "file:Contents/\u{1f600}",
                "file:Contents/\u{ff5e}",
            ]
        );
        let plain = scan_bundle(&root, false).expect("scan");
        let (ScannedEntry::File { sha256: a, chunks, .. }, ScannedEntry::File { sha256: b, chunks: none, .. }) =
            (&entries[1], &plain[1])
        else {
            panic!("big.bin is a file");
        };
        assert_eq!(a, b);
        assert!(chunks.len() > 1 && none.is_empty());
        assert!(matches!(&plain[3], ScannedEntry::File { mode: 0o755, size: 2, .. }));
        assert!(matches!(&plain[0], ScannedEntry::Dir { .. }));
    }
}
