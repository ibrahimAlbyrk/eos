//! Reaching a host: every route it might be on is tried — its direct
//! addresses, a tunnel it opened back to this computer, its relay room — and
//! the first that proves the pinned identity wins.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::LinkRoute;
use eos_core::net::relay::{Relay, RoomJoin};
use eos_domain::peer::{Address, DialFailure, link_error};
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio_rustls::client::TlsStream;

use crate::channel::{BoxIo, Channel, ConnectError};
use crate::relay_io::relay_stream;

pub(crate) type Secured = TlsStream<BoxIo>;

/// How one attempt gets its byte stream.
pub(crate) enum Via {
    Direct(Address),
    /// A tunnel the host opened; taken when the attempt starts.
    Reverse(Box<dyn FnOnce() -> Option<BoxIo> + Send>),
    Relay(RoomJoin),
}

pub(crate) struct Attempt {
    pub(crate) delay: Duration,
    pub(crate) route: LinkRoute,
    pub(crate) via: Via,
}

/// One attempt that did not produce a channel.
#[derive(Debug)]
pub(crate) struct Failed {
    pub(crate) failure: DialFailure,
    /// Whoever answered is not the pinned computer.
    pub(crate) identity: bool,
    /// The link error this failure stands for by itself, when it has one.
    pub(crate) link_code: Option<&'static str>,
    pub(crate) message: String,
}

impl Failed {
    fn new(route: LinkRoute, code: &str, message: impl Into<String>) -> Self {
        Self { failure: DialFailure::new(route, code), identity: false, link_code: None, message: message.into() }
    }

    /// The relay turned this computer's bearer away: the host withdrew it.
    pub(crate) fn relay_denied(&self) -> bool {
        self.failure.route == LinkRoute::Relay && self.failure.code == "BEARER_DENIED"
    }
}

fn connect_failed(route: LinkRoute, e: ConnectError) -> Failed {
    match e {
        ConnectError::IdentityMismatch => {
            Failed { identity: true, ..Failed::new(route, "UNKNOWN", "peer identity mismatch") }
        }
        ConnectError::TimedOut => Failed::new(route, "UNKNOWN", "tls handshake timed out"),
        ConnectError::Io(e) => Failed::new(route, eos_platform::net_error_code(&e), e.to_string()),
    }
}

async fn open(
    channel: &Channel,
    relay: Option<&Arc<dyn Relay>>,
    expect: &str,
    route: LinkRoute,
    via: Via,
    timeout: Duration,
) -> Result<Secured, Failed> {
    let io: BoxIo = match via {
        Via::Direct(addr) => {
            let socket = match tokio::time::timeout(timeout, TcpStream::connect((addr.host.as_str(), addr.port))).await
            {
                Err(_) => return Err(Failed::new(route, "UNKNOWN", "tls handshake timed out")),
                Ok(Err(e)) => return Err(Failed::new(route, eos_platform::net_error_code(&e), e.to_string())),
                Ok(Ok(socket)) => socket,
            };
            // Keystrokes and small frames go out at once instead of waiting on Nagle.
            let _ = socket.set_nodelay(true);
            Box::new(socket)
        }
        Via::Reverse(take) => match take() {
            Some(pipe) => pipe,
            None => {
                return Err(Failed {
                    link_code: Some(link_error::NO_ROUTE),
                    ..Failed::new(route, link_error::NO_ROUTE, "the host's tunnel closed")
                });
            }
        },
        Via::Relay(target) => {
            let Some(relay) = relay else {
                return Err(Failed {
                    link_code: Some(link_error::NO_ROUTE),
                    ..Failed::new(route, link_error::NO_ROUTE, "relay unavailable")
                });
            };
            match relay.dial(target).await {
                Ok(pipe) => relay_stream(pipe),
                Err(e) => return Err(Failed::new(route, &e.code, e.message)),
            }
        }
    };
    channel.connect(io, expect, timeout).await.map_err(|e| connect_failed(route, e))
}

/// Runs the attempts, each after its delay, and returns the first channel.
/// When every attempt fails, their failures come back in the order they ended.
pub(crate) async fn race(
    channel: &Arc<Channel>,
    relay: Option<&Arc<dyn Relay>>,
    expect: &str,
    attempts: Vec<Attempt>,
    timeout: Duration,
) -> Result<(Secured, LinkRoute), Vec<Failed>> {
    let mut running = JoinSet::new();
    for Attempt { delay, route, via } in attempts {
        let (channel, relay, expect) = (channel.clone(), relay.cloned(), expect.to_owned());
        running.spawn(async move {
            tokio::time::sleep(delay).await;
            open(&channel, relay.as_ref(), &expect, route, via, timeout).await.map(|tls| (tls, route))
        });
    }
    let mut failures = Vec::new();
    // Dropping the set on the first success stops the attempts still running.
    while let Some(ended) = running.join_next().await {
        match ended {
            Ok(Ok(won)) => return Ok(won),
            Ok(Err(failed)) => failures.push(failed),
            Err(_) => {}
        }
    }
    Err(failures)
}
