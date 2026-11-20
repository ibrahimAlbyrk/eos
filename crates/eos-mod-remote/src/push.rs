//! Waking the phone (07 §4.6, G38): while the room is held, the push goes on
//! its own connection; otherwise over the relay's HTTP API with the room
//! owner's secret, so a push needs neither the link armed nor the computer
//! held awake.

use std::sync::Arc;
use std::time::Duration;

use eos_core::Error;
use eos_core::net::relay::{PhoneNotify, PhonePush, PushOutcome, PushTarget, RelayError};
use eos_runtime::router::BoxFuture;

use crate::Shared;

/// How long the relay may take to answer a push on the room's connection.
const SOCKET_PUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// [`PhoneNotify`] through this computer's room.
pub(crate) struct RemotePush(pub(crate) Arc<Shared>);

impl PhoneNotify for RemotePush {
    fn push(&self, push: PhonePush) -> BoxFuture<'_, Result<PushOutcome, Error>> {
        Box::pin(async move {
            let outcome = send(&self.0, push).await;
            match &outcome {
                Ok(outcome) => tracing::info!(kind = push.kind.as_str(), count = push.count, ?outcome, "phone push"),
                Err(error) => tracing::info!(kind = push.kind.as_str(), %error, "phone push failed"),
            }
            outcome
        })
    }
}

async fn send(shared: &Shared, push: PhonePush) -> Result<PushOutcome, Error> {
    // This app reaches no relay at all.
    let Some(relay) = shared.parts.relay.clone() else { return Ok(PushOutcome::LinkOff) };
    let room = shared.armed().as_ref().map(|armed| armed.room.clone()).filter(|room| room.online());
    if let Some(room) = room {
        match tokio::time::timeout(SOCKET_PUSH_TIMEOUT, room.push(push)).await {
            Ok(Ok(result)) => return Ok(result.into()),
            // The connection was gone before the push left: HTTP still reaches the relay.
            Ok(Err(RelayError::Offline | RelayError::Closed | RelayError::Behind)) => {}
            Ok(Err(error)) => return Err(Error::Unreachable(format!("relay ({error})"))),
            Err(_) => return Err(Error::Unreachable("relay (no push result in time)".into())),
        }
    }
    let url = shared.parts.config.current().remote.relay.clone().map(|relay| relay.url).filter(|url| !url.is_empty());
    // No relay was ever set: no phone can have been paired.
    let Some(url) = url else { return Ok(PushOutcome::LinkOff) };
    let secrets = shared.parts.store.secrets()?;
    let target = PushTarget { url, room: secrets.room, owner: secrets.owner };
    match relay.push(target, push).await {
        Ok(result) => Ok(result.into()),
        // The relay never saw this room registered: no phone was ever paired through it.
        Err(Error::NotFound { .. }) => Ok(PushOutcome::LinkOff),
        Err(error) => Err(error),
    }
}
