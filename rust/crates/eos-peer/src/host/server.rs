//! The accepting end of the channel (`createSecurePeerServer`): a TCP
//! listener and handed-in pipes feed the same TLS code; each admitted
//! connection is one HTTP/2 session whose streams go to the handler.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use h2::RecvStream;
use h2::server::SendResponse;
use tokio::net::TcpListener;
use tokio::task::AbortHandle;

use crate::channel::goaway;
use crate::channel::h2util::server_handshake;
use crate::channel::{BoxIo, Channel};

/// Where the direct listener binds: the interface asked for, or every
/// interface (`[::]`, taking IPv4 too), as Node's `listen(port)` does.
pub(crate) fn listen_address(host: Option<IpAddr>, port: u16) -> SocketAddr {
    SocketAddr::new(host.unwrap_or(IpAddr::V6(Ipv6Addr::UNSPECIFIED)), port)
}

/// A listening socket at `addr`. An IPv6 one also takes IPv4 connections
/// (as IPv4-mapped addresses) whatever the system's default for new sockets.
pub(crate) fn listener(addr: SocketAddr) -> io::Result<TcpListener> {
    use socket2::{Domain, Socket, Type};
    let socket = Socket::new(Domain::for_address(addr), Type::STREAM, None)?;
    if addr.is_ipv6() {
        socket.set_only_v6(false)?;
    }
    // A restart may bind the port again while the last run's connections wait out TIME_WAIT.
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    TcpListener::from_std(socket.into())
}

/// Who is on the other end of a session that was let in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionPeer {
    pub(crate) fingerprint: Arc<str>,
    /// Paired; otherwise it may only redeem an invite.
    pub(crate) trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Admission {
    Trusted,
    PairingOnly,
    /// Sent to the peer as GOAWAY opaque data so it can stop retrying.
    Refused(&'static str),
}

/// One request stream from a peer.
pub(crate) struct Inbound {
    pub(crate) method: String,
    /// `:path` as sent.
    pub(crate) target: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: RecvStream,
    pub(crate) respond: SendResponse<Bytes>,
}

pub(crate) trait SessionHandler: Send + Sync + 'static {
    fn admit(&self, fingerprint: &str) -> Admission;
    /// Runs on its own task; the stream ends when the future does.
    fn on_stream(&self, stream: Inbound, peer: SessionPeer) -> eos_core::BoxFuture<'static, ()>;
    fn on_session(&self, peer: &SessionPeer, open: bool);
}

struct Listening {
    addr: SocketAddr,
    accept_loop: AbortHandle,
}

#[derive(Default)]
struct State {
    listening: Option<Listening>,
    /// Live sessions per device: each entry stops its session when aborted.
    sessions: HashMap<Arc<str>, Vec<(u64, AbortHandle)>>,
    /// Closed for good: nothing is let in any more.
    closed: bool,
}

pub(crate) struct SecureServer {
    channel: Arc<Channel>,
    handler: Arc<dyn SessionHandler>,
    state: Mutex<State>,
    next_session: AtomicU64,
}

impl std::fmt::Debug for SecureServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecureServer").finish_non_exhaustive()
    }
}

/// A connection's place in the list: under no device while its handshake
/// runs, under its device once it is let in. Dropping it takes the entry out
/// and, for a session that was let in, tells the handler — however the
/// session ends: its connection closing or `disconnect` stopping its task.
struct Listed {
    server: Arc<SecureServer>,
    id: u64,
    peer: Option<SessionPeer>,
}

impl Listed {
    /// Moves the entry under its device. `false` when the server closed or
    /// the entry was dropped meanwhile: the session must not start.
    fn let_in(&mut self, peer: &SessionPeer) -> bool {
        let mut state = self.server.state();
        if state.closed {
            return false;
        }
        let Some(pending) = state.sessions.get_mut(PENDING) else { return false };
        let Some(at) = pending.iter().position(|(id, _)| *id == self.id) else { return false };
        let entry = pending.remove(at);
        if pending.is_empty() {
            state.sessions.remove(PENDING);
        }
        state.sessions.entry(peer.fingerprint.clone()).or_default().push(entry);
        self.peer = Some(peer.clone());
        true
    }
}

impl Drop for Listed {
    fn drop(&mut self) {
        {
            let key: &str = self.peer.as_ref().map_or(PENDING, |peer| &peer.fingerprint);
            let mut state = self.server.state();
            if let Some(list) = state.sessions.get_mut(key) {
                list.retain(|(id, _)| *id != self.id);
                if list.is_empty() {
                    state.sessions.remove(key);
                }
            }
        }
        if let Some(peer) = &self.peer {
            self.server.handler.on_session(peer, false);
        }
    }
}

impl SecureServer {
    pub(crate) fn new(channel: Arc<Channel>, handler: Arc<dyn SessionHandler>) -> Arc<Self> {
        Arc::new(Self { channel, handler, state: Mutex::new(State::default()), next_session: AtomicU64::new(1) })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts taking direct connections. `host` `None` is every interface,
    /// IPv4 and IPv6.
    pub(crate) async fn listen(self: &Arc<Self>, port: u16, host: Option<IpAddr>) -> io::Result<SocketAddr> {
        let listener = listener(listen_address(host, port))?;
        let addr = listener.local_addr()?;
        let server = self.clone();
        let accept_loop = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((socket, _)) => {
                        // Keystrokes and small frames go out at once instead of waiting on Nagle.
                        let _ = socket.set_nodelay(true);
                        server.accept(Box::new(socket));
                    }
                    // Out of descriptors or a connection that died in the queue: keep listening.
                    Err(e) => {
                        tracing::debug!(error = %e, "a peer connection could not be accepted");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
        })
        .abort_handle();
        if let Some(previous) = self.state().listening.replace(Listening { addr, accept_loop }) {
            previous.accept_loop.abort();
        }
        Ok(addr)
    }

    /// Stops taking direct connections; live sessions stay up.
    pub(crate) fn unlisten(&self) {
        if let Some(listening) = self.state().listening.take() {
            listening.accept_loop.abort();
        }
    }

    pub(crate) fn listening(&self) -> Option<SocketAddr> {
        self.state().listening.as_ref().map(|l| l.addr)
    }

    /// Feeds an already-open byte stream (a direct socket, the relay leg, a
    /// reverse tunnel) through the same TLS code.
    pub(crate) fn accept(self: &Arc<Self>, io: BoxIo) {
        let server = self.clone();
        let id = self.next_session.fetch_add(1, Ordering::Relaxed);
        // Registered before the task can run, so `disconnect` never misses it.
        let mut state = self.state();
        if state.closed {
            return;
        }
        let task = tokio::spawn(async move { server.serve(io, id).await });
        state.sessions.entry(PENDING.into()).or_default().push((id, task.abort_handle()));
    }

    async fn serve(self: Arc<Self>, io: BoxIo, id: u64) {
        let mut listed = Listed { server: self.clone(), id, peer: None };
        let (tls, fingerprint) = match self.channel.accept(io).await {
            Ok(done) => done,
            Err(e) => {
                tracing::debug!(error = %e, "peer handshake failed");
                return;
            }
        };
        let trusted = match self.handler.admit(&fingerprint) {
            Admission::Refused(reason) => {
                tracing::info!(fingerprint = &fingerprint[..16], reason, "peer refused");
                let _ = goaway::refuse(tls, reason).await;
                return;
            }
            Admission::Trusted => true,
            Admission::PairingOnly => false,
        };
        let Ok(mut connection) = server_handshake(tls).await else { return };
        let peer = SessionPeer { fingerprint: fingerprint.into(), trusted };
        if !listed.let_in(&peer) {
            return;
        }
        self.handler.on_session(&peer, true);
        while let Some(next) = connection.accept().await {
            let Ok((request, respond)) = next else { break };
            let (head, body) = request.into_parts();
            let target =
                head.uri.path_and_query().map_or_else(|| head.uri.path().to_owned(), |pq| pq.as_str().to_owned());
            let headers = head
                .headers
                .iter()
                .filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned())))
                .collect();
            let stream = Inbound { method: head.method.as_str().to_owned(), target, headers, body, respond };
            tokio::spawn(self.handler.on_stream(stream, peer.clone()));
        }
    }

    /// Drops every live session of a device — revocation and "Disconnect".
    pub(crate) fn disconnect(&self, fingerprint: &str) -> usize {
        let Some(sessions) = self.state().sessions.remove(fingerprint) else { return 0 };
        for (_, task) in &sessions {
            task.abort();
        }
        sessions.len()
    }

    pub(crate) fn disconnect_all(&self) {
        let all: Vec<Arc<str>> = self.state().sessions.keys().cloned().collect();
        for fingerprint in all {
            self.disconnect(&fingerprint);
        }
    }

    /// The devices with at least one live session.
    pub(crate) fn connected(&self) -> Vec<Arc<str>> {
        self.state().sessions.keys().filter(|fp| fp.as_ref() != PENDING).cloned().collect()
    }

    /// Stops listening and drops every session, for good: a connection that
    /// was already on its way in is dropped too.
    pub(crate) fn close(&self) {
        self.state().closed = true;
        self.unlisten();
        self.disconnect_all();
    }
}

/// Where a connection is listed until its handshake says who it is.
const PENDING: &str = "";

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn every_interface_is_the_ipv6_wildcard_and_an_asked_one_is_kept() {
        assert_eq!(listen_address(None, 7402), "[::]:7402".parse().expect("an address"));
        let v4 = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(listen_address(Some(v4), 7402), SocketAddr::new(v4, 7402));
        let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
        assert_eq!(listen_address(Some(v6), 0), SocketAddr::new(v6, 0));
    }

    /// The one IPv6 socket takes an IPv4 caller: bound to the loopback's
    /// IPv4-mapped address, a test never listens beyond this computer.
    #[tokio::test]
    async fn an_ipv6_listener_takes_ipv4_callers_too() {
        let mapped = SocketAddr::new(IpAddr::V6(Ipv4Addr::LOCALHOST.to_ipv6_mapped()), 0);
        let listener = match listener(mapped) {
            Ok(listener) => listener,
            Err(e) => return eprintln!("skipped: this system binds no IPv4-mapped address ({e})"),
        };
        let socket = socket2::SockRef::from(&listener);
        assert!(!socket.only_v6().expect("readable"), "dual stack");
        let port = listener.local_addr().expect("bound").port();
        let accepted = tokio::spawn(async move {
            let (mut stream, from) = listener.accept().await.expect("accepts");
            let mut said = [0u8; 2];
            stream.read_exact(&mut said).await.expect("reads");
            (from, said)
        });
        let mut caller =
            tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.expect("an IPv4 caller connects");
        caller.write_all(b"hi").await.expect("writes");
        let (from, said) = accepted.await.expect("the listener's task");
        assert_eq!(&said, b"hi");
        assert_eq!(from.ip(), IpAddr::V6(Ipv4Addr::LOCALHOST.to_ipv6_mapped()), "seen as IPv4-mapped");
    }

    #[tokio::test]
    async fn an_ipv6_loopback_listener_is_dual_stack_too() {
        let Ok(listener) = listener(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0)) else {
            return eprintln!("skipped: no IPv6 loopback here");
        };
        assert!(!socket2::SockRef::from(&listener).only_v6().expect("readable"));
        let addr = listener.local_addr().expect("bound");
        let caller = tokio::net::TcpStream::connect(addr).await;
        assert!(caller.is_ok(), "an IPv6 caller connects");
    }
}
