//! A push over the relay's HTTP API, for when this computer does not hold its
//! room's connection: `POST /push/v1/<room>` with the room owner's secret.

use std::time::Duration;

use eos_core::Error;
use eos_core::net::relay::{PhonePush, PushResult, PushTarget};
use serde::Serialize;

use crate::control::Control;

/// How long the relay may take, Apple's answer included.
const PUSH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
struct Body {
    kind: &'static str,
    count: u32,
}

/// The relay's HTTP origin for the room's URL: same host, `http(s)` for `ws(s)`.
pub(crate) fn http_origin(relay: &str) -> Option<String> {
    let (scheme, rest) = relay.split_once("://")?;
    let scheme = match scheme {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    let host = rest.split(['/', '?', '#']).next().filter(|host| !host.is_empty())?;
    Some(format!("{scheme}://{host}"))
}

/// The push route on the relay the room's URL names.
pub(crate) fn push_url(relay: &str, room: &str) -> Option<String> {
    Some(format!("{}/push/v1/{room}", http_origin(relay)?))
}

pub(crate) async fn push(http: &reqwest::Client, target: PushTarget, push: PhonePush) -> Result<PushResult, Error> {
    let url = push_url(&target.url, &target.room).ok_or_else(|| Error::Validation("not a relay URL".into()))?;
    // A struct of a word and a number: it always serializes.
    let body = serde_json::to_vec(&Body { kind: push.kind.as_str(), count: push.count }).unwrap_or_default();
    let response = http
        .post(url)
        .bearer_auth(&target.owner)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(PUSH_TIMEOUT)
        .send()
        .await
        .map_err(|_| Error::Unreachable("relay".into()))?;
    match response.status().as_u16() {
        200 => {
            let bytes = response.bytes().await.map_err(|_| Error::Unreachable("relay".into()))?;
            Ok(Control::parse(&bytes).push_result())
        }
        429 => Ok(PushResult { reason: Some("throttled".into()), ..PushResult::default() }),
        404 => Err(Error::not_found("relay room", "this computer's")),
        401 => Err(Error::PermissionDenied("the relay refused this computer's room secret".into())),
        status => Err(Error::Unreachable(format!("relay (HTTP {status})"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_push_route_sits_beside_the_room_s_socket() {
        assert_eq!(push_url("wss://relay.example/", "r1").as_deref(), Some("https://relay.example/push/v1/r1"));
        assert_eq!(push_url("ws://127.0.0.1:9/x?y", "r1").as_deref(), Some("http://127.0.0.1:9/push/v1/r1"));
        assert_eq!(push_url("relay.example", "r1"), None);
        assert_eq!(push_url("ftp://relay.example", "r1"), None);
    }
}
