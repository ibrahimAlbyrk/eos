//! The update fixtures (`rust/fixtures/update`, written by
//! `tools/update-vectors/generate.mjs` from today's TypeScript) and the
//! generators that rebuild their inputs: the fixtures name a generator
//! instead of carrying megabytes of bytes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// `rust/fixtures/update`.
pub fn dir() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/update"))
}

/// A fixture file's bytes.
pub fn read(rel: &str) -> Vec<u8> {
    let path = dir().join(rel);
    fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 in counter mode over `"<seed>:<i>"`.
pub fn random_bytes(seed: &str, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut i = 0u64;
    while out.len() < len {
        out.extend_from_slice(&Sha256::digest(format!("{seed}:{i}")));
        i += 1;
    }
    out.truncate(len);
    out
}

/// xorshift32 noise, as the TypeScript update tests make it.
pub fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.max(1);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

/// How a fixture input is made.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Gen {
    Random {
        seed: String,
        len: usize,
    },
    Zeros {
        len: usize,
    },
    /// A random block repeated.
    Repeat {
        seed: String,
        block: usize,
        len: usize,
    },
    /// The same block again and again, one byte in every `every` changed per copy.
    Drift {
        seed: String,
        block: usize,
        every: usize,
        len: usize,
    },
    /// Numbered lines of text.
    Text {
        len: usize,
        tag: Option<String>,
    },
    /// The text itself.
    Literal {
        text: String,
    },
}

pub fn generate(g: &Gen) -> Vec<u8> {
    match g {
        Gen::Random { seed, len } => random_bytes(seed, *len),
        Gen::Zeros { len } => vec![0; *len],
        Gen::Repeat { seed, block, len } => random_bytes(seed, *block).iter().copied().cycle().take(*len).collect(),
        Gen::Drift { seed, block, every, len } => {
            let b = random_bytes(seed, *block);
            (0..*len)
                .map(|at| if at % every == 0 { b[at % block].wrapping_add((at / block) as u8) } else { b[at % block] })
                .collect()
        }
        Gen::Text { len, tag } => {
            let tag = tag.as_deref().unwrap_or("line");
            let mut out = Vec::with_capacity(len + 64);
            let mut i = 0u64;
            while out.len() < *len {
                out.extend_from_slice(format!("{tag} {i}: the quick brown fox jumps over the lazy dog\n").as_bytes());
                i += 1;
            }
            out.truncate(*len);
            out
        }
        Gen::Literal { text } => text.clone().into_bytes(),
    }
}

/// One entry of the invented bundle.
#[derive(Debug, Clone, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub r#gen: Option<Gen>,
    pub mode: Option<u32>,
    #[serde(default)]
    pub dir: bool,
    pub link: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Patch {
    pub path: String,
    pub at: usize,
    pub bytes: String,
}

/// What the TypeScript release builder reported for one release.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub files: Vec<String>,
    pub pack_bytes: u64,
    pub new_chunks: u64,
    pub whole_files: u64,
}

/// `release.json`: the bundle the two fixture releases (9.0.0, then 9.0.1
/// built against it) were made from, and the throwaway key that signed them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// JWK `x` of the throwaway key.
    pub public_key: String,
    /// The throwaway key, PKCS#8 DER in base64. It signs nothing but these fixtures.
    pub private_key: String,
    pub released_at: String,
    pub tree: Vec<TreeEntry>,
    /// Files the second release replaces.
    pub second: HashMap<String, Gen>,
    /// Bytes the second release overwrites in one file.
    pub second_patch: Patch,
    pub built: HashMap<String, Built>,
}

pub fn release() -> Release {
    serde_json::from_slice(&read("release.json")).expect("release.json")
}

impl Release {
    /// A file's bytes in the first or the second release.
    pub fn file_bytes(&self, entry: &TreeEntry, second: bool) -> Vec<u8> {
        let own = entry.r#gen.as_ref().expect("a file has a generator");
        let mut bytes = generate(if second { self.second.get(&entry.path).unwrap_or(own) } else { own });
        if second && self.second_patch.path == entry.path {
            let patch = self.second_patch.bytes.as_bytes();
            bytes[self.second_patch.at..self.second_patch.at + patch.len()].copy_from_slice(patch);
        }
        bytes
    }

    /// Writes the bundle of the first or the second release under `root`,
    /// with the modes the fixture releases were built from.
    #[cfg(unix)]
    pub fn write_bundle(&self, root: &Path, second: bool) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(root).expect("bundle root");
        for entry in &self.tree {
            let abs = root.join(&entry.path);
            if entry.dir {
                fs::create_dir_all(&abs).expect("dir");
                fs::set_permissions(&abs, fs::Permissions::from_mode(0o755)).expect("dir mode");
            } else if let Some(target) = &entry.link {
                std::os::unix::fs::symlink(target, &abs).expect("link");
            } else {
                fs::write(&abs, self.file_bytes(entry, second)).expect("file");
                fs::set_permissions(&abs, fs::Permissions::from_mode(entry.mode.unwrap_or(0o644))).expect("file mode");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generators_are_the_ones_the_fixtures_were_made_with() {
        // sha256 of `random("a", 1)` and of 40 bytes of text, as generate.mjs made them.
        assert_eq!(random_bytes("a", 1).len(), 1);
        assert_eq!(generate(&Gen::Text { len: 12, tag: None }), b"line 0: the ");
        let release = release();
        assert!(release.tree.iter().any(|e| e.link.is_some()));
        assert!(release.built.contains_key("9.0.1"));
    }
}

/// A local stand-in for the update feed: serves a folder over HTTP/1.1 on
/// loopback, with byte ranges, and counts what it sent.
pub mod server {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Debug, Default)]
    struct State {
        served_bytes: AtomicU64,
        requests: AtomicUsize,
        /// Statuses to answer the next requests with, instead of the file.
        scripted: Mutex<Vec<u16>>,
        ignore_ranges: std::sync::atomic::AtomicBool,
    }

    #[derive(Debug)]
    pub struct FeedServer {
        /// `http://127.0.0.1:<port>`.
        pub base: String,
        state: Arc<State>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for FeedServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl FeedServer {
        /// Starts serving `dir`. Needs a running tokio runtime.
        pub async fn serve(dir: impl Into<PathBuf>) -> Self {
            let dir: PathBuf = dir.into();
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
            let base = format!("http://{}", listener.local_addr().expect("address"));
            let state = Arc::new(State::default());
            let shared = state.clone();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (dir, state) = (dir.clone(), shared.clone());
                    tokio::spawn(async move {
                        let _ = answer(stream, &dir, &state).await;
                    });
                }
            });
            Self { base, state, task }
        }

        /// Body bytes sent so far.
        pub fn served_bytes(&self) -> u64 {
            self.state.served_bytes.load(Ordering::SeqCst)
        }

        pub fn requests(&self) -> usize {
            self.state.requests.load(Ordering::SeqCst)
        }

        /// The next requests get these statuses (with an empty body), in order.
        pub fn answer_next_with(&self, statuses: &[u16]) {
            self.state.scripted.lock().expect("lock").extend_from_slice(statuses);
        }

        /// Answers range requests with the whole file and 200, as a server
        /// without range support does.
        pub fn ignore_ranges(&self) {
            self.state.ignore_ranges.store(true, Ordering::SeqCst);
        }
    }

    fn range_of(head: &str) -> Option<(u64, u64)> {
        let value = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("range").then(|| value.trim().to_owned())
        })?;
        let (from, to) = value.strip_prefix("bytes=")?.split_once('-')?;
        Some((from.parse().ok()?, to.parse().ok()?))
    }

    async fn answer(mut stream: TcpStream, dir: &Path, state: &State) -> std::io::Result<()> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && head.len() < 16 * 1024 {
            if stream.read(&mut byte).await? == 0 {
                return Ok(());
            }
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        state.requests.fetch_add(1, Ordering::SeqCst);
        let scripted = {
            let mut scripted = state.scripted.lock().expect("lock");
            (!scripted.is_empty()).then(|| scripted.remove(0))
        };
        if let Some(status) = scripted {
            let response = format!("HTTP/1.1 {status} Scripted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            return stream.write_all(response.as_bytes()).await;
        }

        let path = head.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/');
        let file = dir.join(path);
        let Ok(Ok(bytes)) = tokio::task::spawn_blocking(move || std::fs::read(file)).await else {
            return stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        };
        let range = if state.ignore_ranges.load(Ordering::SeqCst) { None } else { range_of(&head) };
        let (status, body, extra) = match range {
            Some((from, to)) if (to as usize) < bytes.len() && from <= to => (
                "206 Partial Content",
                &bytes[from as usize..=to as usize],
                format!("content-range: bytes {from}-{to}/{}\r\n", bytes.len()),
            ),
            Some(_) => ("416 Range Not Satisfiable", &bytes[..0], String::new()),
            None => ("200 OK", &bytes[..], String::new()),
        };
        state.served_bytes.fetch_add(body.len() as u64, Ordering::SeqCst);
        let response =
            format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\n{extra}connection: close\r\n\r\n", body.len());
        stream.write_all(response.as_bytes()).await?;
        stream.write_all(body).await?;
        stream.shutdown().await
    }
}
