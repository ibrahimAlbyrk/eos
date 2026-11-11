//! A daemon behind HTTP/1.1: its API port, its raw-content port and its unix
//! socket. One connection per request; nothing here knows about Eos.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Context, bail};

use crate::model::Via;
use crate::sse::SseParser;
use crate::target::{Request, Response, Stream, Target};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Where one listener is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    Tcp { host: String, port: u16 },
    Unix(PathBuf),
}

impl Endpoint {
    /// Parses `http://host:port`.
    pub fn from_url(url: &str) -> anyhow::Result<Self> {
        let rest = url.strip_prefix("http://").with_context(|| format!("expected http://host:port, got {url}"))?;
        let (host, port) = rest.trim_end_matches('/').rsplit_once(':').context("expected a port")?;
        Ok(Self::Tcp { host: host.to_owned(), port: port.parse().context("port")? })
    }

    fn connect(&self) -> anyhow::Result<Conn> {
        match self {
            Self::Tcp { host, port } => {
                let stream = TcpStream::connect((host.as_str(), *port)).with_context(|| format!("{host}:{port}"))?;
                stream.set_nodelay(true)?;
                Ok(Conn::Tcp(stream))
            }
            Self::Unix(path) => Ok(Conn::Unix(UnixStream::connect(path).with_context(|| path.display().to_string())?)),
        }
    }

    fn host_header(&self) -> String {
        match self {
            Self::Tcp { host, port } => format!("{host}:{port}"),
            Self::Unix(_) => "localhost".to_owned(),
        }
    }
}

/// The Node daemon (or anything else that serves the same listeners).
#[derive(Debug, Clone)]
pub struct HttpTarget {
    pub api: Endpoint,
    pub raw: Option<Endpoint>,
    pub socket: Option<Endpoint>,
}

impl HttpTarget {
    fn endpoint(&self, via: Via) -> anyhow::Result<&Endpoint> {
        match via {
            Via::Api => Ok(&self.api),
            Via::Raw => self.raw.as_ref().context("this step goes to the raw-content listener; pass --raw"),
            Via::Socket => self.socket.as_ref().context("this step goes to the control socket; pass --socket"),
        }
    }

    fn exchange(&self, request: &Request) -> anyhow::Result<(Conn, Head, BufReader<Conn>)> {
        let endpoint = self.endpoint(request.via)?;
        let mut conn = endpoint.connect()?;
        conn.set_read_timeout(Some(REQUEST_TIMEOUT))?;
        conn.write_all(&encode(request, &endpoint.host_header()))?;
        conn.flush()?;
        let mut reader = BufReader::new(conn.try_clone()?);
        let head = read_head(&mut reader)?;
        Ok((conn, head, reader))
    }
}

impl Target for HttpTarget {
    fn send(&mut self, request: &Request) -> anyhow::Result<Response> {
        let (_conn, head, mut reader) = self.exchange(request)?;
        let body = read_body(&mut reader, &head, &request.method)?;
        Ok(Response { status: head.status, headers: head.headers, body })
    }

    fn open_stream(&mut self, request: &Request) -> anyhow::Result<Stream> {
        let (conn, head, reader) = self.exchange(request)?;
        // A stream stays quiet for as long as nothing happens.
        conn.set_read_timeout(None)?;
        let (tx, rx) = mpsc::channel();
        let chunked = head.is_chunked();
        std::thread::spawn(move || {
            let body: Box<dyn Read> = if chunked { Box::new(Chunked::new(reader)) } else { Box::new(reader) };
            let mut parser = SseParser::default();
            for line in BufReader::new(body).lines() {
                let Ok(line) = line else { break };
                if let Some(item) = parser.line(line.trim_end_matches('\r'))
                    && tx.send(item).is_err()
                {
                    break;
                }
            }
        });
        Ok(Stream::new(head.status, head.headers, rx, move || conn.shutdown()))
    }

    fn fork(&self) -> Box<dyn Target + Send> {
        Box::new(self.clone())
    }
}

#[derive(Debug)]
enum Conn {
    Tcp(TcpStream),
    Unix(UnixStream),
}

impl Conn {
    fn try_clone(&self) -> std::io::Result<Self> {
        Ok(match self {
            Self::Tcp(s) => Self::Tcp(s.try_clone()?),
            Self::Unix(s) => Self::Unix(s.try_clone()?),
        })
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        match self {
            Self::Tcp(s) => s.set_read_timeout(timeout),
            Self::Unix(s) => s.set_read_timeout(timeout),
        }
    }

    fn shutdown(&self) {
        // Already closed by the other side is fine.
        let _ = match self {
            Self::Tcp(s) => s.shutdown(Shutdown::Both),
            Self::Unix(s) => s.shutdown(Shutdown::Both),
        };
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(s) => s.read(buf),
            Self::Unix(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(s) => s.write(buf),
            Self::Unix(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Tcp(s) => s.flush(),
            Self::Unix(s) => s.flush(),
        }
    }
}

fn encode(request: &Request, default_host: &str) -> Vec<u8> {
    let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.target);
    // A step may send its own Host (the daemon refuses names that are not loopback).
    if !request.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("host: {default_host}\r\n"));
    }
    for (name, value) in &request.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = &request.body {
        head.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    head.push_str("connection: close\r\n\r\n");
    let mut bytes = head.into_bytes();
    if let Some(body) = &request.body {
        bytes.extend_from_slice(body);
    }
    bytes
}

#[derive(Debug)]
struct Head {
    status: u16,
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn is_chunked(&self) -> bool {
        self.header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked"))
    }
}

fn read_head(reader: &mut impl BufRead) -> anyhow::Result<Head> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .with_context(|| format!("not an HTTP status line: {line:?}"))?;
    let mut headers = Vec::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            bail!("connection closed inside the response headers");
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let (name, value) = trimmed.split_once(':').with_context(|| format!("not a header: {trimmed:?}"))?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    Ok(Head { status, headers })
}

fn read_body(reader: &mut impl BufRead, head: &Head, method: &str) -> anyhow::Result<Vec<u8>> {
    let mut body = Vec::new();
    if method == "HEAD" || head.status < 200 || head.status == 204 || head.status == 304 {
        return Ok(body);
    }
    if head.is_chunked() {
        Chunked::new(reader).read_to_end(&mut body)?;
    } else if let Some(length) = head.header("content-length") {
        body.resize(length.parse().context("content-length")?, 0);
        reader.read_exact(&mut body)?;
    } else {
        reader.read_to_end(&mut body)?;
    }
    if head.header("content-encoding") == Some("gzip") {
        let mut plain = Vec::new();
        flate2::read::GzDecoder::new(body.as_slice()).read_to_end(&mut plain).context("gzip body")?;
        return Ok(plain);
    }
    Ok(body)
}

/// Decodes `transfer-encoding: chunked`.
struct Chunked<R> {
    inner: R,
    left: usize,
    done: bool,
}

impl<R: BufRead> Chunked<R> {
    fn new(inner: R) -> Self {
        Self { inner, left: 0, done: false }
    }

    fn next_chunk(&mut self) -> std::io::Result<()> {
        let mut line = String::new();
        if self.inner.read_line(&mut line)? == 0 {
            self.done = true;
            return Ok(());
        }
        let size = line.trim().split(';').next().unwrap_or_default();
        self.left = usize::from_str_radix(size, 16)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bad chunk size {size:?}")))?;
        self.done = self.left == 0;
        Ok(())
    }
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 && !self.done {
            self.next_chunk()?;
        }
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        let want = buf.len().min(self.left);
        let got = self.inner.read(&mut buf[..want])?;
        if got == 0 {
            self.done = true;
            return Ok(0);
        }
        self.left -= got;
        if self.left == 0 {
            // The line break that ends the chunk.
            let mut end = [0u8; 2];
            self.inner.read_exact(&mut end)?;
        }
        Ok(got)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(headers: &[(&str, &str)], body: Option<&str>) -> Request {
        Request {
            via: Via::Api,
            method: "POST".into(),
            target: "/x?a=1".into(),
            headers: headers.iter().map(|(n, v)| ((*n).to_owned(), (*v).to_owned())).collect(),
            body: body.map(|b| b.as_bytes().to_vec()),
        }
    }

    #[test]
    fn encodes_a_request_with_default_and_own_host() {
        let text = String::from_utf8(encode(&request(&[("x-a", "1")], Some("{}")), "127.0.0.1:7500")).expect("utf8");
        assert_eq!(
            text,
            "POST /x?a=1 HTTP/1.1\r\nhost: 127.0.0.1:7500\r\nx-a: 1\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}"
        );
        let own =
            String::from_utf8(encode(&request(&[("Host", "evil.example")], None), "127.0.0.1:7500")).expect("utf8");
        assert_eq!(own, "POST /x?a=1 HTTP/1.1\r\nHost: evil.example\r\nconnection: close\r\n\r\n");
    }

    #[test]
    fn reads_a_sized_body() {
        let mut reader = BufReader::new(
            &b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}extra"[..],
        );
        let head = read_head(&mut reader).expect("head");
        assert_eq!(head.status, 404);
        assert_eq!(head.header("content-type"), Some("application/json"));
        assert_eq!(read_body(&mut reader, &head, "GET").expect("body"), b"{}");
    }

    #[test]
    fn reads_a_chunked_body_and_nothing_for_head() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nwire\r\n3;x=1\r\n is\r\n0\r\n\r\n";
        let mut reader = BufReader::new(&raw[..]);
        let head = read_head(&mut reader).expect("head");
        assert_eq!(read_body(&mut reader, &head, "GET").expect("body"), b"wire is");
        let mut reader = BufReader::new(&raw[..]);
        let head = read_head(&mut reader).expect("head");
        assert!(read_body(&mut reader, &head, "HEAD").expect("body").is_empty());
    }

    #[test]
    fn decodes_gzip() {
        let mut packed = Vec::new();
        let mut encoder = flate2::write::GzEncoder::new(&mut packed, flate2::Compression::fast());
        encoder.write_all(b"{\"ok\":true}").expect("write");
        encoder.finish().expect("finish");
        let mut raw = format!("HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: {}\r\n\r\n", packed.len())
            .into_bytes();
        raw.extend_from_slice(&packed);
        let mut reader = BufReader::new(raw.as_slice());
        let head = read_head(&mut reader).expect("head");
        assert_eq!(read_body(&mut reader, &head, "GET").expect("body"), b"{\"ok\":true}");
    }

    #[test]
    fn parses_endpoints() {
        assert_eq!(
            Endpoint::from_url("http://127.0.0.1:7500/").expect("url"),
            Endpoint::Tcp { host: "127.0.0.1".into(), port: 7500 }
        );
        assert!(Endpoint::from_url("https://x").is_err());
    }
}
