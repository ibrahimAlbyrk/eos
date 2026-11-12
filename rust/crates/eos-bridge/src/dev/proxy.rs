//! The core's router, played by an isolated Node daemon over loopback.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::Error;
use crate::core::{Core, Plane};
use crate::dev::guard;
use crate::transport::{Head, Req, Sink};

#[derive(Debug, Clone)]
pub struct DevDaemonConfig {
    /// The daemon's API origin, e.g. `http://127.0.0.1:7490`.
    pub api_base: String,
    /// Its raw-content origin, e.g. `http://127.0.0.1:7491`.
    pub raw_base: String,
    /// The daemon's ui-token (read from its home; never logged).
    pub ui_token: String,
}

pub struct DevDaemon {
    config: DevDaemonConfig,
    client: reqwest::Client,
    rt: tokio::runtime::Handle,
    forwarded: AtomicU64,
    refused: AtomicU64,
}

impl std::fmt::Debug for DevDaemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevDaemon")
            .field("api_base", &self.config.api_base)
            .field("raw_base", &self.config.raw_base)
            .finish_non_exhaustive()
    }
}

fn h(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

impl DevDaemon {
    pub fn new(config: DevDaemonConfig, rt: tokio::runtime::Handle) -> Result<Self, Error> {
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(8)
            .no_proxy()
            .build()
            .map_err(|e| Error::DevProxy(e.to_string()))?;
        Ok(DevDaemon { config, client, rt, forwarded: AtomicU64::new(0), refused: AtomicU64::new(0) })
    }

    pub fn config(&self) -> &DevDaemonConfig {
        &self.config
    }

    /// Requests forwarded and writes refused so far.
    pub fn counts(&self) -> (u64, u64) {
        (self.forwarded.load(Ordering::Relaxed), self.refused.load(Ordering::Relaxed))
    }
}

/// Headers of the page's request that mean nothing to the daemon or would mislead it.
fn forwards_request_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "host" | "origin" | "referer" | "accept-encoding" | "connection" | "content-length" | "cookie"
    ) && !name.starts_with("sec-")
}

/// Hop-by-hop headers, and the daemon's CORS answers: the page is same-origin here.
fn forwards_response_header(name: &str) -> bool {
    !matches!(name, "transfer-encoding" | "connection" | "keep-alive") && !name.starts_with("access-control-")
}

impl Core for DevDaemon {
    fn ui_token(&self) -> String {
        self.config.ui_token.clone()
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        // The path without its query: which side served what, for whoever watches the port.
        let path = req.url.split_once('?').map_or(req.url.as_str(), |(path, _)| path);
        tracing::debug!(target: "eos::bridge", side = "proxy", method = %req.method, %path);
        if !guard::allows(&req.method, &req.url) {
            self.refused.fetch_add(1, Ordering::Relaxed);
            return sink.respond(
                403,
                vec![h("content-type", "application/json")],
                br#"{"error":"dev proxy: writes to the daemon are refused"}"#,
            );
        }
        self.forwarded.fetch_add(1, Ordering::Relaxed);
        let base = match plane {
            Plane::Api => &self.config.api_base,
            Plane::Raw => &self.config.raw_base,
        };
        let url = format!("{}{}", base.trim_end_matches('/'), req.url);
        let client = self.client.clone();
        self.rt.spawn(async move {
            let method = reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::GET);
            let mut builder = client.request(method, &url);
            for (name, value) in &req.headers {
                if forwards_request_header(name) {
                    builder = builder.header(name.as_str(), value.as_str());
                }
            }
            // The daemon's CORS gate knows the Electron origin.
            if req.header("origin").is_some() {
                builder = builder.header("origin", "eos://app");
            }
            if !req.body.is_empty() {
                builder = builder.body(req.body);
            }
            let response = tokio::select! {
                r = builder.send() => r,
                _ = sink.cancelled() => return,
            };
            let mut response = match response {
                Ok(r) => r,
                Err(_) => {
                    return sink.respond(
                        502,
                        vec![h("content-type", "application/json")],
                        br#"{"error":"dev proxy: daemon unreachable"}"#,
                    );
                }
            };
            let headers = response
                .headers()
                .iter()
                .filter(|(name, _)| forwards_response_header(name.as_str()))
                .filter_map(|(name, value)| Some((name.as_str().to_string(), value.to_str().ok()?.to_string())))
                .collect();
            sink.head(Head { status: response.status().as_u16(), headers });
            loop {
                tokio::select! {
                    chunk = response.chunk() => match chunk {
                        Ok(Some(bytes)) => {
                            if !sink.chunk_async(&bytes).await {
                                break;
                            }
                        }
                        _ => {
                            sink.end();
                            break;
                        }
                    },
                    // The page dropped the request (an EventSource closed, a navigation):
                    // dropping the response closes the daemon's side too.
                    _ = sink.cancelled() => break,
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::transport::{Body, Read, channel};

    async fn read_to_end(body: &Body) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        for _ in 0..600 {
            match body.read(&mut buf, || {}) {
                Read::Data(n) => out.extend_from_slice(&buf[..n]),
                Read::End => return out,
                Read::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        panic!("the body never ended");
    }

    /// One-connection-at-a-time HTTP server: records each request head, answers with `reply`.
    async fn serve(reply: &'static [u8]) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    log.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).into_owned());
                    let _ = socket.write_all(reply).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (base, seen)
    }

    fn daemon(base: &str) -> DevDaemon {
        DevDaemon::new(
            DevDaemonConfig { api_base: base.to_string(), raw_base: base.to_string(), ui_token: "t".into() },
            tokio::runtime::Handle::current(),
        )
        .unwrap()
    }

    fn req(method: &str, target: &str, headers: &[(&str, &str)]) -> Req {
        Req {
            method: method.into(),
            url: target.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_read_is_forwarded_and_the_answer_comes_back_without_cors_headers() {
        let (base, seen) =
            serve(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\naccess-control-allow-origin: eos://app\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}").await;
        let (sink, body) = channel();
        daemon(&base).call(
            Plane::Api,
            req(
                "GET",
                "/health?x=1",
                &[
                    ("x-eos-ui-token", "t"),
                    ("origin", "http://eos.localhost"),
                    ("sec-fetch-dest", "empty"),
                    ("cookie", "a=b"),
                    ("referer", "http://eos.localhost/"),
                ],
            ),
            sink,
        );
        assert_eq!(read_to_end(&body).await, b"{\"ok\":true}");
        let head = body.head().unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.header("content-type"), Some("application/json"));
        assert_eq!(head.header("access-control-allow-origin"), None);
        let request = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(request.starts_with("get /health?x=1 http/1.1"), "{request}");
        assert!(request.contains("x-eos-ui-token: t"));
        assert!(request.contains("origin: eos://app"), "the daemon's CORS gate knows the Electron origin");
        assert!(!request.contains("sec-fetch-dest") && !request.contains("cookie:") && !request.contains("referer:"));
    }

    #[tokio::test]
    async fn a_write_to_an_agent_route_never_leaves_the_proxy() {
        let (base, seen) = serve(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await;
        let proxy = daemon(&base);
        let (sink, body) = channel();
        proxy.call(Plane::Api, req("POST", "/workers/w1/message", &[("x-eos-ui-token", "t")]), sink);
        assert_eq!(body.head().unwrap().status, 403);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(seen.lock().unwrap().is_empty(), "nothing may reach the daemon");
        assert_eq!(proxy.counts(), (0, 1));
    }

    #[tokio::test]
    async fn an_unreachable_daemon_is_a_502() {
        let (sink, body) = channel();
        daemon("http://127.0.0.1:9").call(Plane::Raw, req("GET", "/fs/raw", &[]), sink);
        read_to_end(&body).await;
        assert_eq!(body.head().unwrap().status, 502);
    }

    #[tokio::test]
    async fn closing_the_page_side_closes_the_daemon_side() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\ndata: 1\n\n").await;
            // An event stream: stays open until the reader goes away.
            let n = socket.read(&mut buf).await.unwrap_or(0);
            flag.store(n == 0, Ordering::SeqCst);
        });
        let (sink, body) = channel();
        daemon(&base).call(Plane::Api, req("GET", "/stream", &[]), sink);
        let mut buf = [0u8; 64];
        for _ in 0..200 {
            if body.read_now(&mut buf) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(&buf[..9], b"data: 1\n\n");
        body.cancel();
        for _ in 0..200 {
            if closed.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the upstream connection stayed open after the page cancelled");
    }
}
