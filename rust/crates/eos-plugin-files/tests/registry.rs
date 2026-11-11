//! The npm source through the real guarded client, against a registry served
//! from this computer.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use eos_contracts::{PluginSource, PluginSourceNpm};
use eos_core::plugin::{PluginCloner, PluginFetcher};
use eos_kit_net::{Resolver, SafeFetcher, is_blocked_ip};
use eos_plugin_files::{GuardedHttp, HttpFailure, PluginFetchers, RegistryHttp};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct TestDns;

impl Resolver for TestDns {
    fn resolve<'a>(&'a self, host: &'a str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async move {
            match host {
                "registry.test" => Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]),
                "lan.test" => Ok(vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))]),
                _ => Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("getaddrinfo ENOTFOUND {host}"))),
            }
        })
    }
}

/// The server is on loopback, so the guard is told 127.0.0.1 is public; every
/// other private address stays refused.
fn loopback_is_public(address: IpAddr) -> bool {
    address != IpAddr::V4(Ipv4Addr::LOCALHOST) && is_blocked_ip(address)
}

struct NoGit;

impl PluginCloner for NoGit {
    fn shallow_clone<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: &'a std::path::Path,
    ) -> eos_core::BoxFuture<'a, Result<String, eos_core::Error>> {
        Box::pin(std::future::ready(Err(eos_core::Error::Validation("no git here".into()))))
    }
}

struct Registry {
    base: String,
    /// The request heads the server saw.
    seen: Arc<Mutex<Vec<String>>>,
    http: GuardedHttp,
}

async fn registry() -> Registry {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let port = listener.local_addr().expect("an address").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                log.lock().expect("the log").push(head);
                let (status, body): (&str, Vec<u8>) = match path.as_str() {
                    "/eos-clock" => (
                        "200 OK",
                        br#"{"dist-tags":{"latest":"1.2.0"},"versions":{"1.2.0":{"dist":{"tarball":"http://registry.test/eos-clock.tgz","integrity":"sha512-AAAA"}}}}"#.to_vec(),
                    ),
                    "/@acme%2fnotes" => ("200 OK", br#"{"dist-tags":{},"versions":{}}"#.to_vec()),
                    "/big" => ("200 OK", vec![b'x'; 5000]),
                    "/broken" => ("500 Internal Server Error", b"oops".to_vec()),
                    _ => ("404 Not Found", b"{}".to_vec()),
                };
                let mut out =
                    format!("HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n", body.len())
                        .into_bytes();
                out.extend(body);
                let _ = socket.write_all(&out).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    let fetcher = SafeFetcher::with(Arc::new(TestDns), loopback_is_public).expect("a fetcher");
    Registry { base: format!("http://registry.test:{port}"), seen, http: GuardedHttp(fetcher) }
}

async fn install(registry: &Registry, base: &str, name: &str) -> String {
    let fetchers = PluginFetchers::new(Arc::new(registry.http.clone()), base, Arc::new(NoGit));
    let dir = tempfile::tempdir().expect("a folder");
    let source = PluginSource::Npm(PluginSourceNpm { name: name.to_owned(), version: None });
    let error = fetchers.fetch(&source, dir.path()).await.expect_err("these all fail before a tarball");
    assert_eq!(std::fs::read_dir(dir.path()).expect("the folder").count(), 0, "nothing was written");
    error.to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_version_list_is_asked_for_the_way_npm_serves_it() {
    let registry = registry().await;
    // The local registry cannot serve https, which is itself the rule under test.
    assert_eq!(
        install(&registry, &registry.base, "eos-clock").await,
        "eos-clock@1.2.0's tarball isn't served over https"
    );
    let seen = registry.seen.lock().expect("the log");
    assert_eq!(seen.len(), 1, "the tarball was never asked for");
    assert!(seen[0].starts_with("get /eos-clock http/1.1"), "{}", seen[0]);
    assert!(seen[0].contains("accept: application/vnd.npm.install-v1+json"), "{}", seen[0]);
    assert!(seen[0].contains("user-agent: eos plugin installer"), "{}", seen[0]);
}

#[tokio::test(flavor = "multi_thread")]
async fn registry_answers_become_sentences() {
    let registry = registry().await;
    assert_eq!(install(&registry, &registry.base, "missing").await, "missing isn't on npm");
    assert_eq!(install(&registry, &registry.base, "broken").await, "the npm registry answered 500 for broken");
    assert_eq!(install(&registry, &registry.base, "@acme/notes").await, "@acme/notes has no version or tag \"latest\"");
    assert!(registry.seen.lock().expect("the log").iter().any(|head| head.starts_with("get /@acme%2fnotes ")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_registry_on_a_private_address_or_out_of_reach_is_not_fetched() {
    let registry = registry().await;
    assert_eq!(
        install(&registry, "http://lan.test", "eos-clock").await,
        "couldn't reach the npm registry for eos-clock: lan.test resolves to a private or local address (192.168.1.20)"
    );
    assert_eq!(
        install(&registry, "http://169.254.169.254", "eos-clock").await,
        "couldn't reach the npm registry for eos-clock: 169.254.169.254 is a private or local address"
    );
    let unreachable = install(&registry, "http://nowhere.test", "eos-clock").await;
    assert!(unreachable.starts_with("couldn't reach the npm registry for eos-clock: "), "{unreachable}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_past_the_cap_is_refused_while_it_is_read() {
    let registry = registry().await;
    let url = format!("{}/big", registry.base);
    assert_eq!(registry.http.get(&url, None, 4096).await, Err(HttpFailure::TooLarge));
    assert_eq!(registry.http.get(&url, None, 5000).await.map(|body| body.len()), Ok(5000));
}
