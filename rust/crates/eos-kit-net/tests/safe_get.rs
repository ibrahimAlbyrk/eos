//! The guarded GET against a local server: `infra/src/__tests__/genui-safe-fetch.test.ts`
//! and the lookup cases of `genui-net-guard.test.ts`.

use std::future::Future;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use eos_kit_net::{Error, Resolver, SafeFetcher, SafeGetOptions, is_blocked_ip};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const PNG: [u8; 16] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).expect("gzip");
    encoder.finish().expect("gzip")
}

fn response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\nconnection: close\r\n").into_bytes();
    for (name, value) in headers {
        out.extend(format!("{name}: {value}\r\n").into_bytes());
    }
    if !headers.iter().any(|(name, _)| *name == "transfer-encoding") {
        out.extend(format!("content-length: {}\r\n", body.len()).into_bytes());
    }
    out.extend(b"\r\n");
    out.extend(body);
    out
}

async fn serve(mut socket: TcpStream, port: u16, hits: Arc<AtomicUsize>) {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    hits.fetch_add(1, Ordering::SeqCst);
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let h = |name: &'static str, value: &str| (name, value.to_owned());
    let bytes = match path.as_str() {
        "/img.png" if head.contains("user-agent: eos/test") => {
            response("200 OK", &[h("content-type", "image/png")], &PNG)
        }
        "/img.png" => response("400 Bad Request", &[], b"wrong user agent"),
        "/big" => response("200 OK", &[h("content-type", "image/png")], &[0u8; 10_000]),
        "/chunked-big" => {
            let mut body = Vec::new();
            for _ in 0..10 {
                body.extend(b"3e8\r\n");
                body.extend([0u8; 1000]);
                body.extend(b"\r\n");
            }
            body.extend(b"0\r\n\r\n");
            response("200 OK", &[h("content-type", "image/png"), h("transfer-encoding", "chunked")], &body)
        }
        "/bomb" => response(
            "200 OK",
            &[h("content-type", "image/png"), h("content-encoding", "gzip")],
            &gzip(&vec![0u8; 1_000_000]),
        ),
        "/gz" => response(
            "200 OK",
            &[h("content-type", "text/html"), h("content-encoding", "gzip")],
            &gzip(b"<html>hi</html>"),
        ),
        "/page" => response("200 OK", &[h("content-type", "Text/HTML; charset=utf-8")], b"<html></html>"),
        "/untyped" => response("200 OK", &[], b"?"),
        "/to-private" => response("302 Found", &[h("location", "http://10.0.0.1/secret")], b""),
        "/to-rebind" => response("302 Found", &[h("location", &format!("http://rebind.test:{port}/img.png"))], b""),
        "/to-metadata" => {
            response("307 Temporary Redirect", &[h("location", "http://169.254.169.254/latest/meta-data/")], b"")
        }
        "/to-img" => response("301 Moved Permanently", &[h("location", "/img.png")], b""),
        "/to-nowhere" => response("302 Found", &[h("location", "http://[bad")], b""),
        "/slow" => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            return;
        }
        p if p.starts_with("/loop") => {
            let n: u32 = p[5..].parse().unwrap_or(0);
            response("302 Found", &[h("location", &format!("/loop{}", n + 1))], b"")
        }
        _ => response("404 Not Found", &[], b""),
    };
    let _ = socket.write_all(&bytes).await;
    let _ = socket.shutdown().await;
}

/// The test server lives on loopback, so the guard is told 127.0.0.1 is
/// "public"; every other private address stays refused.
fn loopback_is_public(address: IpAddr) -> bool {
    address != IpAddr::V4(Ipv4Addr::LOCALHOST) && is_blocked_ip(address)
}

struct TestDns;

impl Resolver for TestDns {
    fn resolve<'a>(&'a self, host: &'a str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async move {
            let ip = |a, b, c, d| IpAddr::V4(Ipv4Addr::new(a, b, c, d));
            match host {
                "public.test" => Ok(vec![ip(127, 0, 0, 1)]),
                "rebind.test" => Ok(vec![ip(10, 0, 0, 7)]),
                "lan.test" => Ok(vec![ip(192, 168, 1, 20)]),
                // One public address does not make up for a private one.
                "mixed.test" => Ok(vec![ip(93, 184, 216, 34), ip(192, 168, 0, 5)]),
                "empty.test" => Ok(Vec::new()),
                _ => Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("getaddrinfo ENOTFOUND {host}"))),
            }
        })
    }
}

struct Server {
    base: String,
    hits: Arc<AtomicUsize>,
    fetcher: SafeFetcher,
}

async fn start() -> Server {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve(socket, port, counter.clone()));
        }
    });
    let fetcher = SafeFetcher::with(Arc::new(TestDns), loopback_is_public).expect("fetcher");
    Server { base: format!("http://public.test:{port}"), hits, fetcher }
}

fn options() -> SafeGetOptions {
    let mut options = SafeGetOptions::new("Eos/test", 4096);
    options.timeout = Duration::from_secs(5);
    options
}

fn is_image(content_type: &str) -> bool {
    content_type.starts_with("image/")
}

async fn code(fetcher: &SafeFetcher, url: &str) -> &'static str {
    fetcher.get(url, &options()).await.map_or_else(|e| e.code(), |_| "ok")
}

impl Server {
    async fn get(&self, path: &str) -> Result<eos_kit_net::SafeResponse, Error> {
        self.fetcher.get(&format!("{}{path}", self.base), &options()).await
    }

    async fn code(&self, path: &str) -> &'static str {
        code(&self.fetcher, &format!("{}{path}", self.base)).await
    }
}

#[tokio::test]
async fn an_image_is_fetched_through_the_guarded_lookup() {
    let server = start().await;
    let image = SafeGetOptions { accept_type: Some(is_image), ..options() };
    let r = server.fetcher.get(&format!("{}/img.png", server.base), &image).await.expect("get");
    assert_eq!(r.status, 200);
    assert_eq!(r.content_type, "image/png");
    assert_eq!(r.body.as_ref(), PNG);
    assert_eq!(r.headers.get("content-type").and_then(|v| v.to_str().ok()), Some("image/png"));
}

#[tokio::test]
async fn a_same_site_redirect_is_followed_and_the_final_url_reported() {
    let server = start().await;
    let r = server.get("/to-img").await.expect("get");
    assert_eq!(r.url, format!("{}/img.png", server.base));
    assert_eq!(r.body.as_ref(), PNG);
}

#[tokio::test]
async fn private_and_loopback_targets_are_refused_before_connecting() {
    let server = start().await;
    for url in ["http://lan.test/x", "http://mixed.test/x", "http://10.0.0.1/x"] {
        assert_eq!(code(&server.fetcher, url).await, "blocked", "{url}");
    }
    // With the system's resolver and the real rules, loopback by name and by number.
    let real = SafeFetcher::new().expect("fetcher");
    let small = SafeGetOptions::new("t", 10);
    let by_name = real.get("http://localhost:7400/health", &small).await.expect_err("refused");
    assert_eq!(by_name.code(), "blocked", "{by_name}");
    assert!(by_name.to_string().starts_with("localhost resolves to a private or local address ("), "{by_name}");
    assert_eq!(real.get("http://127.0.0.1:7400/health", &small).await.expect_err("refused").code(), "blocked");
    assert_eq!(server.hits.load(Ordering::SeqCst), 0, "nothing was connected to");
}

#[tokio::test]
async fn the_refusal_names_the_private_address() {
    let fetcher = SafeFetcher::with(Arc::new(TestDns), loopback_is_public).expect("fetcher");
    let err = fetcher.get("http://mixed.test/x", &options()).await.expect_err("refused");
    assert_eq!(err, Error::Blocked("mixed.test resolves to a private or local address (192.168.0.5)".to_owned()));
}

#[tokio::test]
async fn every_redirect_hop_is_checked_again() {
    let server = start().await;
    assert_eq!(server.code("/to-private").await, "blocked");
    assert_eq!(server.code("/to-rebind").await, "blocked");
    assert_eq!(server.code("/to-metadata").await, "blocked");
    assert_eq!(
        server.get("/to-nowhere").await.expect_err("bad target"),
        Error::Network("the redirect target is not a URL".to_owned())
    );
}

#[tokio::test]
async fn it_stops_after_three_redirects() {
    let server = start().await;
    assert_eq!(server.get("/loop").await.expect_err("too many"), Error::Redirects(3));
    assert_eq!(server.hits.load(Ordering::SeqCst), 4, "the first request and three redirects");
}

#[tokio::test]
async fn an_oversize_body_is_refused_declared_streamed_or_decompressed() {
    let server = start().await;
    assert_eq!(server.get("/big").await.expect_err("declared"), Error::TooLarge("10000 bytes, max 4096".to_owned()));
    assert_eq!(
        server.get("/chunked-big").await.expect_err("streamed"),
        Error::TooLarge("more than 4096 bytes".to_owned())
    );
    assert_eq!(server.code("/bomb").await, "too-large");
}

#[tokio::test]
async fn gzip_is_decoded() {
    let server = start().await;
    assert_eq!(server.get("/gz").await.expect("get").body.as_ref(), b"<html>hi</html>");
}

#[tokio::test]
async fn the_content_type_is_checked_before_the_body_is_read() {
    let server = start().await;
    let image = SafeGetOptions { accept_type: Some(is_image), ..options() };
    let err = server.fetcher.get(&format!("{}/page", server.base), &image).await.expect_err("wrong type");
    assert_eq!(err, Error::Type("text/html".to_owned()));
    let err = server.fetcher.get(&format!("{}/untyped", server.base), &image).await.expect_err("no type");
    assert_eq!(err.to_string(), "a response without a type is not what was asked for");
    // Lower-cased and without parameters for the caller too.
    assert_eq!(server.get("/page").await.expect("get").content_type, "text/html");
}

#[tokio::test]
async fn a_non_2xx_answer_a_timeout_and_a_dead_name_are_reported() {
    let server = start().await;
    assert_eq!(server.get("/nope").await.expect_err("404"), Error::Status(404));
    let quick = SafeGetOptions { timeout: Duration::from_millis(150), ..options() };
    let err = server.fetcher.get(&format!("{}/slow", server.base), &quick).await.expect_err("timeout");
    assert_eq!(err.code(), "timeout");
    assert_eq!(code(&server.fetcher, "http://nowhere.test/x").await, "network");
    assert_eq!(code(&server.fetcher, "http://empty.test/x").await, "network");
}

/// Answers loopback (the test server) once, then a private address: what a
/// rebinding DNS server does between a check and a connect.
struct Rebinding(AtomicUsize);

impl Resolver for Rebinding {
    fn resolve<'a>(
        &'a self,
        _host: &'a str,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(
            async move { Ok(vec![IpAddr::V4(if first { Ipv4Addr::LOCALHOST } else { Ipv4Addr::new(10, 0, 0, 7) })]) },
        )
    }
}

#[tokio::test]
async fn the_connection_goes_to_the_address_that_was_checked() {
    let server = start().await;
    let dns = Arc::new(Rebinding(AtomicUsize::new(0)));
    let fetcher = SafeFetcher::with(dns.clone(), loopback_is_public).expect("fetcher");
    let url = server.base.replace("public.test", "flip.test") + "/img.png";

    // One lookup serves both the check and the connect: there is no second
    // answer for the socket to follow.
    let r = fetcher.get(&url, &options()).await.expect("get");
    assert_eq!(r.body.as_ref(), PNG);
    assert_eq!(dns.0.load(Ordering::SeqCst), 1);

    // A later connection resolves again and meets the private answer.
    let other_port = url.replace("flip.test", "flip2.test");
    assert_eq!(code(&fetcher, &other_port).await, "blocked");
}

#[tokio::test]
async fn the_plain_client_follows_redirects_and_decodes() {
    let server = start().await;
    let client = eos_kit_net::http_client(&eos_kit_net::ClientOptions::new("Eos/test")).expect("client");
    let base = server.base.replace("public.test", "127.0.0.1");
    let image = client.get(format!("{base}/to-img")).send().await.expect("send");
    assert_eq!(image.status(), 200);
    assert_eq!(image.bytes().await.expect("body").as_ref(), PNG);
    let page = client.get(format!("{base}/gz")).send().await.expect("send");
    assert_eq!(page.text().await.expect("body"), "<html>hi</html>");
}
