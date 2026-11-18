//! The hosts a capability declares, and whether a host it asks for is one
//! of them. A declared host is a domain name (`api.github.com`) or `*.` and a
//! domain for every name under it (`*.githubusercontent.com`); never an IP
//! address, a name without a dot (`localhost`), or a wildcard over a whole
//! top-level domain (`*.com`).

use std::net::IpAddr;

/// Why a declared host is refused; `None` for a host that may be declared.
pub fn host_problem(host: &str) -> Option<&'static str> {
    if host.parse::<IpAddr>().is_ok() || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok() {
        return Some("An IP address is not a host; declare a domain name");
    }
    let (wildcard, domain) = match host.strip_prefix("*.") {
        Some(domain) => (true, domain),
        None => (false, host),
    };
    let labels: Vec<&str> = domain.split('.').collect();
    if !labels.iter().all(|label| valid_label(label)) || domain.len() > 253 {
        return Some("Not a domain name: lowercase letters, digits, hyphens and dots");
    }
    if labels.last().is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit())) {
        return Some("An IP address is not a host; declare a domain name");
    }
    match labels.len() {
        1 if wildcard => Some("A wildcard over a whole top-level domain reaches every site in it"),
        1 => Some("A name without a dot is not a host on the internet"),
        _ => None,
    }
}

fn valid_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

/// Whether `host` (as a request names it, in any case, maybe with a
/// trailing dot) is one of `declared`. A wildcard covers the names under its
/// domain, not the domain itself.
pub fn allows(declared: &[String], host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    declared.iter().any(|pattern| match pattern.strip_prefix("*.") {
        Some(domain) => host.strip_suffix(domain).is_some_and(|rest| rest.len() > 1 && rest.ends_with('.')),
        None => host == *pattern,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_host_is_a_domain_name_or_a_wildcard_under_one() {
        for good in ["api.github.com", "github.com", "*.githubusercontent.com", "*.co.uk", "x-1.example.org"] {
            assert_eq!(host_problem(good), None, "{good}");
        }
        for (bad, why) in [
            ("127.0.0.1", "IP"),
            ("10.0.0.8", "IP"),
            ("::1", "IP"),
            ("[::1]", "IP"),
            ("1.2.3", "IP"),
            ("*.com", "top-level"),
            ("*", "domain name"),
            ("localhost", "without a dot"),
            ("API.github.com", "domain name"),
            ("api.github.com:443", "domain name"),
            ("https://api.github.com", "domain name"),
            ("api..github.com", "domain name"),
            ("-api.github.com", "domain name"),
            ("api.*.github.com", "domain name"),
            ("*.*.github.com", "domain name"),
            ("", "domain name"),
        ] {
            let problem = host_problem(bad).unwrap_or_else(|| panic!("{bad} passed"));
            assert!(problem.contains(why), "{bad}: {problem}");
        }
    }

    #[test]
    fn a_host_is_allowed_only_by_its_own_name_or_a_wildcard_above_it() {
        let declared = vec!["api.github.com".to_owned(), "*.githubusercontent.com".to_owned()];
        for allowed in [
            "api.github.com",
            "API.GitHub.com",
            "api.github.com.",
            "raw.githubusercontent.com",
            "a.b.githubusercontent.com",
        ] {
            assert!(allows(&declared, allowed), "{allowed}");
        }
        for refused in [
            "github.com",
            "evil-api.github.com",
            "api.github.com.evil.net",
            "githubusercontent.com",
            "evilgithubusercontent.com",
            "x.evilgithubusercontent.com",
            "",
        ] {
            assert!(!allows(&declared, refused), "{refused}");
        }
        assert!(!allows(&[], "api.github.com"), "nothing declared reaches nothing");
    }
}
