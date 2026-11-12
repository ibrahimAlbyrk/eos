//! The rules of the browser that need no browser: where an agent may navigate, what a tool
//! result may carry, and which storage a session's tabs use.

use eos_contracts::GLOBAL_SESSION;
use eos_core::shell::THROWAWAY_PROFILE;
use serde_json::{Map, Value};
use url::Url;

use crate::axtree::quoted;

/// Who is driving. Read from what the request proves (the user's token, an agent id), never
/// from its body: an agent cannot claim to be the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    Human,
    Agent,
}

/// The origin allowlist, for agents only: the user driving their own panel is never fenced.
/// An empty list restricts nothing. An entry is an origin (`https://example.com`) or a bare
/// host (`example.com`: any http or https scheme, the host exactly). `Err` is the text of
/// the 403.
pub fn check_navigation(url: &str, actor: Actor, allowed: &[String]) -> Result<(), String> {
    if actor == Actor::Human || allowed.is_empty() || url == "about:blank" {
        return Ok(());
    }
    let Ok(parsed) = Url::parse(url) else {
        return Err(format!("navigation blocked: {} is not a valid URL", quoted(url)));
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "navigation blocked: {}: URLs are not allowed while browser.allowedOrigins is set",
            parsed.scheme()
        ));
    }
    let origin = parsed.origin().ascii_serialization();
    let hostname = parsed.host_str().unwrap_or("").to_lowercase();
    let host = match parsed.port() {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.clone(),
    };
    let listed = allowed.iter().any(|entry| {
        let entry = eos_domain::text::js_trim(entry).to_lowercase();
        if entry.is_empty() {
            false
        } else if entry.contains("://") {
            entry == origin.to_lowercase()
        } else {
            entry == host || entry == hostname
        }
    });
    if listed {
        Ok(())
    } else {
        Err(format!(
            "navigation blocked: {origin} is not in browser.allowedOrigins — agent navigation is restricted to that list; the operator can navigate the panel by hand or extend the allowlist"
        ))
    }
}

/// The host an http(s) navigation goes to, without port or brackets, for the shell's
/// local-network rule. `None` for any other address (`about:blank`, `data:`).
pub fn host_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    Some(host.trim_start_matches('[').trim_end_matches(']').to_owned())
}

/// Whether a header may reach a tool result: the credential carriers by name, and the
/// token / key / session naming family.
fn is_sensitive_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(name.as_str(), "authorization" | "proxy-authorization" | "cookie" | "set-cookie")
        || ["token", "secret", "apikey", "api-key", "api_key", "session", "auth"].iter().any(|part| name.contains(part))
}

/// Replaces the value of every credential header. Replaced, not dropped: the caller still
/// sees which headers existed.
pub fn redact_headers(headers: &Map<String, Value>) -> Map<String, Value> {
    headers
        .iter()
        .map(|(name, value)| {
            let value = if is_sensitive_header(name) { Value::String("[redacted]".into()) } else { value.clone() };
            (name.clone(), value)
        })
        .collect()
}

fn is_string_record(value: &Value) -> bool {
    value.as_object().is_some_and(|map| map.values().all(Value::is_string))
}

/// What an agent gets of a response: any `…headers` map anywhere in it is redacted. No
/// response carries headers today; this is what keeps a future one from leaking a
/// credential into a tool result.
pub fn redact_for_agent(payload: Value) -> Value {
    match payload {
        Value::Array(items) => Value::Array(items.into_iter().map(redact_for_agent).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let headers = key.to_ascii_lowercase().ends_with("headers") && is_string_record(&value);
                    let value = match (&value, headers) {
                        (Value::Object(inner), true) => Value::Object(redact_headers(inner)),
                        _ => redact_for_agent(value),
                    };
                    (key, value)
                })
                .collect(),
        ),
        other => other,
    }
}

/// The folder-safe form of a session key: the global session keeps the name `profile`, as
/// its folder was called before sessions had their own. Anything but letters, digits, `.`,
/// `_` and `-` becomes `_` (per UTF-16 unit, as the keys were sanitized before), so a
/// free-form `?session=` can never name a path.
pub fn profile_key(session_key: &str) -> String {
    if session_key == GLOBAL_SESSION {
        return "profile".to_owned();
    }
    let mut safe = String::with_capacity(session_key.len());
    for c in session_key.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            safe.push(c);
        } else {
            safe.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    safe
}

/// The name of the storage (cookies, logins) a session's tabs share. `throwaway` is set when
/// profiles are not kept (`browser.persistProfile: false`): the name then says so and holds
/// this run's start, and the shell removes such storage at the next launch.
pub fn profile_name(session_key: &str, throwaway: Option<i64>) -> String {
    match throwaway {
        None => format!("browser-{}", profile_key(session_key)),
        Some(run) => format!("{THROWAWAY_PROFILE}browser-{run}-{}", profile_key(session_key)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_names() {
        assert_eq!(profile_name("global", None), "browser-profile");
        assert_eq!(profile_name("o-1a2b", None), "browser-o-1a2b");
        assert_eq!(profile_name("../x y", None), "browser-.._x_y");
        assert_eq!(profile_name("w/😀", None), "browser-w___");
        assert_eq!(profile_name("o-1", Some(42)), "tmp-browser-42-o-1");
    }

    #[test]
    fn the_host_of_a_navigation() {
        assert_eq!(host_of("http://localhost:5173/app").as_deref(), Some("localhost"));
        assert_eq!(host_of("https://Example.COM/").as_deref(), Some("example.com"));
        assert_eq!(host_of("http://[::1]:8080/").as_deref(), Some("::1"));
        assert_eq!(host_of("http://user@192.168.1.20:3000/x").as_deref(), Some("192.168.1.20"));
        assert_eq!(host_of("about:blank"), None);
        assert_eq!(host_of("file:///etc/hosts"), None);
        assert_eq!(host_of("not a url"), None);
    }
}
