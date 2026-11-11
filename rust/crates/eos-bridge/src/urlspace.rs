//! The URL space of the app's own origin.
//!
//! ```text
//! http://eos.localhost/                 index.html (+ the bridge script, CSP header)
//! http://eos.localhost/assets/…         the dashboard bundle
//! http://eos.localhost/_core/…          the core's router
//! http://eos.localhost/_shell/…         the shell's bridges
//! http://eos.localhost/plugins/…        plugin builds (the core's `/ui/plugins/…`)
//! http://raw.eos.localhost/…            raw-content origin: sandboxed HTML, pdf.js, media
//! ```

/// The dashboard's origin host.
pub const APP_HOST: &str = "eos.localhost";
/// The raw-content origin host: a different origin from the dashboard on purpose.
pub const RAW_HOST: &str = "raw.eos.localhost";
/// What the dashboard uses as the core's base URL.
pub const CORE_BASE: &str = "http://eos.localhost/_core";
pub const RAW_BASE: &str = "http://raw.eos.localhost";

/// Where a request to the app's hosts goes. Targets are origin-form: path plus `?query`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The core's API router; the target has the `/_core` prefix removed.
    Core(String),
    /// The core's raw-content router.
    Raw(String),
    /// A plugin build, as the core's target (`/ui/plugins/<id>/<rev>.js`). Read-only.
    Plugin(String),
    /// A shell bridge: the path below `/_shell/`, and the query without `?`.
    Shell { path: String, query: String },
    /// A file of the dashboard bundle; `""` is the entry document.
    Asset(String),
    /// Not one of the app's hosts, or not a URL.
    Unknown,
}

/// Splits `http://host[:port]/path?query#fragment` into host, path and query.
fn split(url: &str) -> Option<(&str, &str, &str)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, target) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split_once(':').map_or(host, |(h, _)| h);
    let target = target.split_once('#').map_or(target, |(t, _)| t);
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    Some((host, if path.is_empty() { "/" } else { path }, query))
}

fn target(path: &str, query: &str) -> String {
    let path = if path.is_empty() { "/" } else { path };
    if query.is_empty() { path.to_string() } else { format!("{path}?{query}") }
}

pub fn route(url: &str) -> Route {
    let Some((host, path, query)) = split(url) else { return Route::Unknown };
    if host.eq_ignore_ascii_case(RAW_HOST) {
        return Route::Raw(target(path, query));
    }
    if !host.eq_ignore_ascii_case(APP_HOST) {
        return Route::Unknown;
    }
    if let Some(rest) = below(path, "/_core") {
        return Route::Core(target(rest, query));
    }
    if let Some(rest) = below(path, "/_shell") {
        return Route::Shell { path: rest.trim_start_matches('/').to_string(), query: query.to_string() };
    }
    if below(path, "/plugins").is_some() {
        return if is_plugin_build(path) { Route::Plugin(format!("/ui{path}")) } else { Route::Unknown };
    }
    Route::Asset(path.trim_start_matches('/').to_string())
}

/// `/plugins/<id>/<rev>.js|css`: the only plugin paths there are.
fn is_plugin_build(path: &str) -> bool {
    let Some((id, file)) = path.strip_prefix("/plugins/").and_then(|rest| rest.split_once('/')) else { return false };
    // Starts with a letter or digit, so `.` and `..` are not ids.
    let id_ok = id.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    let Some((rev, ext)) = file.split_once('.') else { return false };
    id_ok && !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit()) && matches!(ext, "js" | "css")
}

/// The part of `path` below `prefix`, when `path` is the prefix itself or a path under it.
fn below<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix(prefix)?;
    (rest.is_empty() || rest.starts_with('/')).then_some(rest)
}

/// Reads one query parameter (no decoding beyond `%XX`).
pub fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == name).then(|| percent_decode(v))
    })
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = bytes.get(i + 1..i + 3)
            && let Some(v) = std::str::from_utf8(hex).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_requests_lose_the_prefix_and_keep_the_query() {
        assert_eq!(route("http://eos.localhost/_core/health"), Route::Core("/health".into()));
        assert_eq!(
            route("http://eos.localhost/_core/workers/w1/events?since=4&x=a%20b"),
            Route::Core("/workers/w1/events?since=4&x=a%20b".into())
        );
        assert_eq!(route("http://eos.localhost/_core"), Route::Core("/".into()));
        assert_eq!(route("http://eos.localhost/_core?x=1"), Route::Core("/?x=1".into()));
    }

    #[test]
    fn a_prefix_must_end_at_a_path_boundary() {
        assert_eq!(route("http://eos.localhost/_corelike/x"), Route::Asset("_corelike/x".into()));
        assert_eq!(route("http://eos.localhost/_shellfish"), Route::Asset("_shellfish".into()));
        assert_eq!(route("http://eos.localhost/pluginsx/a.js"), Route::Asset("pluginsx/a.js".into()));
    }

    #[test]
    fn shell_bridges() {
        assert_eq!(
            route("http://eos.localhost/_shell/browserView/setBounds"),
            Route::Shell { path: "browserView/setBounds".into(), query: String::new() }
        );
        assert_eq!(
            route("http://eos.localhost/_shell/events?t=abc"),
            Route::Shell { path: "events".into(), query: "t=abc".into() }
        );
    }

    #[test]
    fn plugins_are_the_cores_ui_plugins() {
        assert_eq!(
            route("http://eos.localhost/plugins/clock/12.js?v=3"),
            Route::Plugin("/ui/plugins/clock/12.js".into())
        );
        assert_eq!(
            route("http://eos.localhost/plugins/my.plugin-2/7.css"),
            Route::Plugin("/ui/plugins/my.plugin-2/7.css".into())
        );
    }

    #[test]
    fn only_plugin_builds_are_plugin_paths() {
        for bad in [
            "/plugins/",
            "/plugins/clock",
            "/plugins/clock/a.js",
            "/plugins/clock/1.html",
            "/plugins/Clock/1.js",
            "/plugins/a/b/1.js",
            "/plugins/../1.js",
        ] {
            assert_eq!(route(&format!("http://eos.localhost{bad}")), Route::Unknown, "{bad}");
        }
    }

    #[test]
    fn assets_and_the_entry_document() {
        assert_eq!(route("http://eos.localhost/"), Route::Asset(String::new()));
        assert_eq!(route("http://eos.localhost"), Route::Asset(String::new()));
        assert_eq!(route("http://eos.localhost/index.html"), Route::Asset("index.html".into()));
        assert_eq!(route("http://eos.localhost/assets/index-abc.js#frag"), Route::Asset("assets/index-abc.js".into()));
    }

    #[test]
    fn the_raw_origin_is_its_own_host() {
        assert_eq!(
            route("http://raw.eos.localhost/fs/raw?path=%2Ftmp%2Fa.pdf"),
            Route::Raw("/fs/raw?path=%2Ftmp%2Fa.pdf".into())
        );
        assert_eq!(route("http://RAW.eos.localhost/_core/health"), Route::Raw("/_core/health".into()));
    }

    #[test]
    fn other_hosts_and_schemes_are_unknown() {
        assert_eq!(route("http://evil.example/_core/health"), Route::Unknown);
        assert_eq!(route("http://eos.localhost.evil.example/_core/health"), Route::Unknown);
        assert_eq!(route("http://evil.example@eos.localhost.evil/_core"), Route::Unknown);
        assert_eq!(route("https://eos.localhost/_core/health"), Route::Unknown);
        assert_eq!(route("eos://app/index.html"), Route::Unknown);
        assert_eq!(route("not a url"), Route::Unknown);
    }

    #[test]
    fn userinfo_and_port_do_not_change_the_host() {
        assert_eq!(route("http://user:pw@eos.localhost:80/_core/x"), Route::Core("/x".into()));
    }

    #[test]
    fn query_params() {
        assert_eq!(query_param("t=abc&x=1", "t").as_deref(), Some("abc"));
        assert_eq!(query_param("x=a%2Fb", "x").as_deref(), Some("a/b"));
        assert_eq!(query_param("x=1", "t"), None);
        assert_eq!(percent_decode("a%zzb%4"), "a%zzb%4");
    }
}
