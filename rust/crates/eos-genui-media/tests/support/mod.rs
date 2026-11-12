//! A local HTTP server that answers what a test scripted and keeps what it
//! was asked. Stands in for every outside service: no test here leaves the
//! computer.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub(crate) method: String,
    /// Path and query, as sent.
    pub(crate) target: String,
    /// The request head in lower case.
    pub(crate) head: String,
    pub(crate) body: String,
}

impl Seen {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().find_map(|line| line.strip_prefix(name)?.strip_prefix(':').map(str::trim))
    }
}

pub(crate) struct Reply {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(&'static str, String)>,
    pub(crate) body: Vec<u8>,
}

impl Reply {
    pub(crate) fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self { status, headers: vec![("content-type", content_type.to_owned())], body: body.into() }
    }

    pub(crate) fn json(body: &serde_json::Value) -> Self {
        Self::new(200, "application/json; charset=utf-8", body.to_string())
    }

    pub(crate) fn redirect(to: &str) -> Self {
        Self { status: 302, headers: vec![("location", to.to_owned())], body: Vec::new() }
    }
}

type Handler = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

pub(crate) struct Server {
    pub(crate) addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    pub(crate) async fn start(handler: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
        let addr = listener.local_addr().expect("an address");
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let (handler, log): (Handler, _) = (Arc::new(handler), seen.clone());
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(serve(socket, handler.clone(), log.clone()));
            }
        });
        Self { addr, seen }
    }

    pub(crate) fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub(crate) fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen").clone()
    }

    pub(crate) fn targets(&self) -> Vec<String> {
        self.seen().into_iter().map(|seen| seen.target).collect()
    }
}

async fn serve(mut socket: TcpStream, handler: Handler, log: Arc<Mutex<Vec<Seen>>>) {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
        }
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let lower = head.to_ascii_lowercase();
    let length: usize = lower
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or(0);
    while raw.len() < head_end + length {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
        }
    }
    let mut first = head.lines().next().unwrap_or_default().split_whitespace();
    let seen = Seen {
        method: first.next().unwrap_or_default().to_owned(),
        target: first.next().unwrap_or_default().to_owned(),
        head: lower,
        body: String::from_utf8_lossy(&raw[head_end..head_end + length]).into_owned(),
    };
    let reply = handler(&seen);
    log.lock().expect("seen").push(seen);
    let mut out =
        format!("HTTP/1.1 {} X\r\nconnection: close\r\ncontent-length: {}\r\n", reply.status, reply.body.len());
    for (name, value) in &reply.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    let _ = socket.write_all(out.as_bytes()).await;
    let _ = socket.write_all(&reply.body).await;
    let _ = socket.shutdown().await;
}
