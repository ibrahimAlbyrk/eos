//! A local HTTP server that answers what the test tells it, and a keychain
//! file of the test's own. Nothing here reaches the network or the user's
//! login keychain.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One request the server got.
#[derive(Debug, Clone)]
pub(crate) struct Hit {
    pub(crate) method: String,
    /// Path and query.
    pub(crate) target: String,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) body: String,
}

impl Hit {
    pub(crate) fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }
}

pub(crate) struct FakeServer {
    pub(crate) url: String,
    hits: Arc<Mutex<Vec<Hit>>>,
}

impl FakeServer {
    /// `answer`: status and JSON body for each request.
    pub(crate) async fn start(answer: impl Fn(&Hit) -> (u16, String) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a local port");
        let url = format!("http://{}", listener.local_addr().expect("the address"));
        let hits: Arc<Mutex<Vec<Hit>>> = Arc::default();
        let (seen, answer) = (hits.clone(), Arc::new(answer));
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (seen, answer) = (seen.clone(), answer.clone());
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    let (head_end, length) = loop {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buf[..n]);
                        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&raw[..at]).to_lowercase();
                            let length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (at + 4, length);
                        }
                    };
                    while raw.len() < head_end + length {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        raw.extend_from_slice(&buf[..n]);
                    }
                    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap_or_default().split(' ');
                    let hit = Hit {
                        method: first.next().unwrap_or_default().to_owned(),
                        target: first.next().unwrap_or_default().to_owned(),
                        headers: lines
                            .filter_map(|l| l.split_once(':'))
                            .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
                            .collect(),
                        body: String::from_utf8_lossy(&raw[head_end..]).into_owned(),
                    };
                    let (status, body) = answer(&hit);
                    seen.lock().expect("hits").push(hit);
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { url, hits }
    }

    pub(crate) fn hits(&self) -> Vec<Hit> {
        self.hits.lock().expect("hits").clone()
    }

    pub(crate) fn hits_to(&self, path: &str) -> Vec<Hit> {
        self.hits().into_iter().filter(|h| h.path() == path).collect()
    }
}

/// The value of `name` in a URL's query or a form body, decoded.
pub(crate) fn query_value(text: &str, name: &str) -> Option<String> {
    let query = text.split_once('?').map_or(text, |(_, q)| q);
    query.split('&').filter_map(|pair| pair.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| decode(v))
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                i += 2;
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "macos")]
pub(crate) mod keychain {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const SECURITY: &str = "/usr/bin/security";

    pub(crate) fn security(args: &[&str]) -> String {
        let out = Command::new(SECURITY).args(args).output().expect("security");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A keychain file of the test's own. The login keychain is never opened
    /// and the user's search list is left as it was.
    pub(crate) struct Throwaway {
        _dir: tempfile::TempDir,
        pub(crate) path: PathBuf,
        search_list: String,
    }

    impl Throwaway {
        pub(crate) fn create() -> Self {
            let dir = tempfile::tempdir().expect("dir");
            let path = dir.path().join("eos-test.keychain-db");
            let p = path.to_str().expect("utf-8 path").to_owned();
            let search_list = security(&["list-keychains", "-d", "user"]);
            security(&["create-keychain", "-p", "test", &p]);
            security(&["set-keychain-settings", &p]);
            security(&["unlock-keychain", "-p", "test", &p]);
            Self { _dir: dir, path, search_list }
        }

        pub(crate) fn path(&self) -> &str {
            self.path.to_str().expect("utf-8 path")
        }

        /// Adds an item the way the claude binary does: named by the store's
        /// service, with the user's name as its account.
        pub(crate) fn add_as_claude(&self, store_dir: &Path, json: &str) {
            let service = eos_platform::claude_store_service(Some(store_dir));
            security(&["add-generic-password", "-s", &service, "-a", "someone", "-w", json, self.path()]);
        }

        /// How many items the keychain holds for the store, and their account.
        pub(crate) fn items_of(&self, store_dir: &Path) -> (usize, bool) {
            let service = eos_platform::claude_store_service(Some(store_dir));
            let dump = security(&["dump-keychain", self.path()]);
            let count = dump.matches(&format!("\"svce\"<blob>=\"{service}\"")).count();
            (count, dump.contains("\"acct\"<blob>=\"someone\""))
        }
    }

    impl Drop for Throwaway {
        fn drop(&mut self) {
            security(&["delete-keychain", self.path.to_str().unwrap_or_default()]);
            let after = security(&["list-keychains", "-d", "user"]);
            if after != self.search_list {
                // Creating a keychain must not change the search list; put it back if it did.
                let before: Vec<String> =
                    self.search_list.lines().map(|l| l.trim().trim_matches('"').to_owned()).collect();
                let mut args = vec!["list-keychains", "-d", "user", "-s"];
                args.extend(before.iter().map(String::as_str));
                security(&args);
            }
        }
    }
}
