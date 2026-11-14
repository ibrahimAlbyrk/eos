//! Keeping pages off the local network, without getting in the user's way.
//!
//! macOS asks the user to let the app "find devices on local networks" the moment anything
//! in it connects to the LAN, and a page can cause that with one request. So every profile
//! gets a proxy script (`lan_guard.pac`) that refuses the local network before DNS and
//! before connect. Two things keep that from costing the user anything:
//!
//! - a page on the local network the user asked for (a dev server on another machine, a
//!   `.local` name typed into the browser panel) opens that view's profile for as long as
//!   the view stays on the local network ([`LocalPage`]);
//! - the system's proxy settings are carried inside the script ([`SystemProxy`]), because a
//!   proxy script replaces them otherwise.

use std::net::{IpAddr, ToSocketAddrs};

use base64::Engine;
use serde_json::json;

const SCRIPT: &str = include_str!("lan_guard.pac");

/// The fixed proxies and exceptions of the system's network settings.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SystemProxy {
    /// `host:port` for plain http.
    pub http: Option<String>,
    /// `host:port` for https.
    pub https: Option<String>,
    /// `host:port` of a SOCKS proxy.
    pub socks: Option<String>,
    /// Hosts and domains that bypass the proxies.
    pub exceptions: Vec<String>,
    /// The system is set to a proxy script or to auto-discovery. That cannot be carried
    /// inside our script: such a system gets direct connections.
    pub automatic: bool,
}

impl SystemProxy {
    /// Reads the output of `scutil --proxy`.
    pub fn parse_scutil(text: &str) -> Self {
        let mut values = std::collections::HashMap::new();
        let mut exceptions = Vec::new();
        let mut in_exceptions = false;
        for line in text.lines() {
            let Some((key, value)) = line.split_once(" : ") else {
                if line.trim() == "}" {
                    in_exceptions = false;
                }
                continue;
            };
            let (key, value) = (key.trim(), value.trim());
            if key == "ExceptionsList" {
                in_exceptions = true;
            } else if in_exceptions && key.bytes().all(|b| b.is_ascii_digit()) {
                // Only names: an address range is the local network, which never reaches a proxy.
                if !value.contains('/') && !value.is_empty() {
                    exceptions.push(value.to_ascii_lowercase());
                }
            } else {
                values.insert(key.to_string(), value.to_string());
            }
        }
        let on = |key: &str| values.get(key).is_some_and(|v| v == "1");
        let server = |kind: &str| {
            let host = values.get(&format!("{kind}Proxy")).filter(|h| !h.is_empty())?;
            let port = values.get(&format!("{kind}Port")).filter(|p| p.bytes().all(|b| b.is_ascii_digit()))?;
            on(&format!("{kind}Enable")).then(|| format!("{host}:{port}"))
        };
        SystemProxy {
            http: server("HTTP"),
            https: server("HTTPS"),
            socks: server("SOCKS"),
            exceptions,
            automatic: on("ProxyAutoConfigEnable") || on("ProxyAutoDiscoveryEnable"),
        }
    }

    /// Asks the system. Empty settings when it cannot be asked.
    pub fn read() -> Self {
        std::process::Command::new("/usr/sbin/scutil")
            .arg("--proxy")
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| Self::parse_scutil(&String::from_utf8_lossy(&out.stdout)))
            .unwrap_or_default()
    }
}

/// The proxy script for a profile. `open`: the local network is reachable (the user asked
/// for a page there).
pub fn script(open: bool, system: &SystemProxy) -> String {
    let system =
        json!({ "http": system.http, "https": system.https, "socks": system.socks, "except": system.exceptions });
    SCRIPT.replace("__OPEN__", if open { "true" } else { "false" }).replace("__SYSTEM__", &system.to_string())
}

/// The script as the URL Chromium's `proxy` preference takes.
pub fn script_url(open: bool, system: &SystemProxy) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(script(open, system));
    format!("data:application/x-ns-proxy-autoconfig;base64,{encoded}")
}

fn is_local_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_multicast() || v4.is_broadcast(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.to_ipv4_mapped().is_some_and(|v4| is_local_address(IpAddr::V4(v4)))
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xff00) == 0xff00
        }
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Whether a host is on the local network by its spelling alone: a LAN address, a `.local`
/// name, a bare name. The same rule as the script's.
pub fn is_local_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host.is_empty() || is_loopback(&host) {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => is_local_address(ip),
        Err(_) => host.ends_with(".local") || !host.contains('.'),
    }
}

/// [`is_local_host`], or a public-looking name that resolves into the local network.
/// Blocks on the system resolver; only for a host the user asked for.
pub fn reaches_local_network(host: &str) -> bool {
    if is_local_host(host) {
        return true;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.is_empty() || is_loopback(&bare.to_ascii_lowercase()) || bare.parse::<IpAddr>().is_ok() {
        return false;
    }
    (bare, 0).to_socket_addrs().is_ok_and(|mut addresses| addresses.any(|a| is_local_address(a.ip())))
}

/// The host of an http(s) URL, without port or brackets.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(v6) = host.strip_prefix('[') { v6.split(']').next()? } else { host.split(':').next()? };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// A view's standing with the local network.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum LocalPage {
    /// Guarded, like every view by default.
    #[default]
    None,
    /// The user asked for a page on this host; the view is on its way there.
    Asked(String),
    /// The view shows a page on the local network.
    On(String),
}

impl LocalPage {
    /// Whether the view's profile may reach the local network.
    pub fn is_open(&self) -> bool {
        !matches!(self, LocalPage::None)
    }

    /// The user asked for a page on `host` in this view.
    pub fn asked(&mut self, host: &str) {
        *self = LocalPage::Asked(host.to_ascii_lowercase());
    }

    /// The view's top-level page is now at `url`. Arriving where the user asked, or moving
    /// between pages of the local network, keeps the view open; going anywhere else ends it,
    /// so a third-party page never inherits the opening. A page that commits while the asked
    /// one is still on its way (the page that was loading before) changes nothing.
    pub fn navigated(&mut self, url: &str) {
        let host = host_of(url);
        *self = match (&*self, host) {
            (LocalPage::None, _) => LocalPage::None,
            (LocalPage::Asked(asked), Some(host)) if *asked == host => LocalPage::On(host),
            (LocalPage::Asked(asked), _) => LocalPage::Asked(asked.clone()),
            (LocalPage::On(_), Some(host)) if is_local_host(&host) => LocalPage::On(host),
            (LocalPage::On(on), Some(host)) if *on == host => LocalPage::On(host),
            (LocalPage::On(_), _) => LocalPage::None,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_hosts_by_their_spelling() {
        for host in [
            "192.168.1.1",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.1",
            "169.254.1.1",
            "224.0.0.251",
            "255.255.255.255",
            "[fe80::1]",
            "fd00::1",
            "ff02::fb",
            "::ffff:192.168.1.1",
            "printer.local",
            "MacBook-Pro.LOCAL",
            "router",
            "nas",
        ] {
            assert!(is_local_host(host), "{host}");
        }
        for host in [
            "example.com",
            "8.8.8.8",
            "100.100.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "2606:4700::1111",
            "localhost",
            "app.localhost",
            "127.0.0.1",
            "::1",
            "[::1]",
            "",
        ] {
            assert!(!is_local_host(host), "{host}");
        }
    }

    #[test]
    fn a_literal_or_loopback_is_never_resolved() {
        assert!(reaches_local_network("192.168.1.20"));
        assert!(reaches_local_network("dev-box.local"));
        assert!(!reaches_local_network("8.8.8.8"));
        assert!(!reaches_local_network("localhost"));
        assert!(!reaches_local_network("127.0.0.1"));
        assert!(!reaches_local_network(""));
    }

    #[test]
    fn hosts_of_urls() {
        assert_eq!(host_of("http://192.168.1.20:3000/app?x=1").as_deref(), Some("192.168.1.20"));
        assert_eq!(host_of("https://User@Dev-Box.Local/").as_deref(), Some("dev-box.local"));
        assert_eq!(host_of("http://[fe80::1]:8080/").as_deref(), Some("fe80::1"));
        assert_eq!(host_of("https://example.com").as_deref(), Some("example.com"));
        assert_eq!(host_of("about:blank"), None);
        assert_eq!(host_of("http:///x"), None);
    }

    #[test]
    fn a_view_is_open_only_while_it_is_where_the_user_asked() {
        let mut page = LocalPage::default();
        assert!(!page.is_open());
        page.navigated("http://192.168.1.20:3000/");
        assert!(!page.is_open(), "a page that takes itself to the LAN was not asked for");

        page.asked("192.168.1.20");
        assert!(page.is_open());
        // The page that was still loading commits first: nothing changes.
        page.navigated("https://example.com/slow");
        assert_eq!(page, LocalPage::Asked("192.168.1.20".into()));
        page.navigated("http://192.168.1.20:3000/");
        assert_eq!(page, LocalPage::On("192.168.1.20".into()));
        // Around the local network it stays open: a login on another LAN host, a `.local` name.
        page.navigated("http://192.168.1.21/login");
        page.navigated("http://nas.local/");
        assert_eq!(page, LocalPage::On("nas.local".into()));
        // Leaving for the web closes it: the next page is a third party again.
        page.navigated("https://example.com/");
        assert_eq!(page, LocalPage::None);
        page.navigated("http://192.168.1.20:3000/");
        assert!(!page.is_open(), "coming back by itself does not reopen it");
    }

    #[test]
    fn a_name_that_resolves_into_the_lan_stays_open_on_its_own_host_only() {
        let mut page = LocalPage::default();
        page.asked("dev.corp.example");
        page.navigated("https://dev.corp.example/");
        assert_eq!(page, LocalPage::On("dev.corp.example".into()));
        page.navigated("https://dev.corp.example/other");
        assert!(page.is_open());
        page.navigated("about:blank");
        assert_eq!(page, LocalPage::None);
    }

    const NO_PROXY: &str =
        "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n  FTPPassive : 1\n}\n";
    const FIXED: &str = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n    2 : Intranet.Example\n  }\n  ExcludeSimpleHostnames : 1\n  FTPPassive : 1\n  HTTPEnable : 1\n  HTTPPort : 3128\n  HTTPProxy : proxy.example\n  HTTPSEnable : 1\n  HTTPSPort : 3129\n  HTTPSProxy : proxy.example\n  SOCKSEnable : 0\n  SOCKSPort : 1080\n  SOCKSProxy : socks.example\n}\n";
    const AUTOMATIC: &str =
        "<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad.example/proxy.pac\n}\n";

    #[test]
    fn the_systems_settings_are_read() {
        assert_eq!(
            SystemProxy::parse_scutil(NO_PROXY),
            SystemProxy { exceptions: vec!["*.local".into()], ..SystemProxy::default() }
        );
        let fixed = SystemProxy::parse_scutil(FIXED);
        assert_eq!(fixed.http.as_deref(), Some("proxy.example:3128"));
        assert_eq!(fixed.https.as_deref(), Some("proxy.example:3129"));
        assert_eq!(fixed.socks, None, "configured but switched off");
        assert_eq!(fixed.exceptions, vec!["*.local".to_string(), "intranet.example".to_string()]);
        assert!(!fixed.automatic);
        assert!(SystemProxy::parse_scutil(AUTOMATIC).automatic);
        assert_eq!(SystemProxy::parse_scutil(""), SystemProxy::default());
        assert_eq!(SystemProxy::parse_scutil("garbage\n : \n}"), SystemProxy::default());
    }

    #[test]
    fn the_script_carries_the_state_and_the_settings() {
        let guarded = script(false, &SystemProxy::default());
        assert!(guarded.contains("var OPEN = false;"));
        assert!(guarded.contains(r#"var SYSTEM = {"http":null,"https":null,"socks":null,"except":[]};"#));
        assert!(!guarded.contains("__"));
        let open = script(true, &SystemProxy::parse_scutil(FIXED));
        assert!(open.contains("var OPEN = true;"));
        assert!(open.contains(r#""http":"proxy.example:3128","https":"proxy.example:3129","socks":null,"except":["*.local","intranet.example"]"#));
        assert!(
            script_url(false, &SystemProxy::default()).starts_with("data:application/x-ns-proxy-autoconfig;base64,")
        );
    }
}
