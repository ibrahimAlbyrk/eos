//! How a project folder is named when it travels between computers: by its
//! repository's remote, since the same repository lives at a different path
//! on each computer.

/// `git@github.com:Owner/repo.git`, `https://user@github.com/Owner/repo`,
/// `ssh://git@host:22/o/r` → `github.com/Owner/repo` (host in lower case;
/// user, port and `.git` dropped). `None` for anything that is not a remote URL.
pub fn normalize_remote(url: &str) -> Option<String> {
    let u = url.trim();
    let (host, path) = scp_like(u).or_else(|| with_scheme(u))?;
    let path = path.strip_suffix(".git/").or_else(|| path.strip_suffix(".git")).unwrap_or(path);
    let path = path.trim_matches('/');
    (!path.is_empty()).then(|| format!("{}/{path}", host.to_lowercase()))
}

/// `user@host:path`.
fn scp_like(u: &str) -> Option<(&str, &str)> {
    let (user, rest) = u.split_once('@')?;
    if user.is_empty() || user.contains(['/', ' ', '\t', '\n', '\r']) {
        return None;
    }
    let end = rest.find([':', '/', ' ', '\t', '\n', '\r'])?;
    let (host, tail) = rest.split_at(end);
    let path = tail.strip_prefix(':')?;
    (!host.is_empty() && !path.is_empty() && !path.contains('\n')).then_some((host, path))
}

/// `scheme://[user@]host[:port]/path`.
fn with_scheme(u: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = u.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphabetic() || c == '+') {
        return None;
    }
    let (authority, path) = rest.split_once('/')?;
    let host_port = match authority.split_once('@') {
        Some((user, host)) if !user.is_empty() => host,
        Some(_) => return None,
        None => authority,
    };
    let host = match host_port.split_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return None,
        None => host_port,
    };
    (!host.is_empty() && !path.is_empty() && !path.contains('\n')).then_some((host, path))
}

/// The key of a folder inside a repository: `git:<remote>` plus `#sub/dir`
/// when the folder is not the repository's root.
pub fn git_key(remote: &str, sub: &str) -> String {
    if sub.is_empty() || sub.starts_with("..") { format!("git:{remote}") } else { format!("git:{remote}#{sub}") }
}

/// The key of a folder with no remote.
pub fn path_key(path: &str) -> String {
    format!("path:{path}")
}

/// A `git:` key's remote and the folder inside the repository, if any.
pub fn split_git_key(key: &str) -> Option<(&str, Option<&str>)> {
    let rest = key.strip_prefix("git:")?;
    Some(match rest.split_once('#') {
        Some((remote, sub)) => (remote, Some(sub.split('#').next().unwrap_or(sub))),
        None => (rest, None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_urls_reduce_to_host_and_path() {
        for (url, key) in [
            ("git@github.com:Owner/repo.git", "github.com/Owner/repo"),
            ("https://user@GitHub.com/Owner/repo", "github.com/Owner/repo"),
            ("https://github.com/Owner/repo.git/", "github.com/Owner/repo"),
            ("ssh://git@host.example:22/o/r", "host.example/o/r"),
            ("git+ssh://git@host/o/r.git", "host/o/r"),
            ("  git@gitlab.com:group/sub/repo.git  ", "gitlab.com/group/sub/repo"),
        ] {
            assert_eq!(normalize_remote(url).as_deref(), Some(key), "{url}");
        }
        for not_a_remote in ["", "/local/path", "repo", "https://host", "https://host/"] {
            assert_eq!(normalize_remote(not_a_remote), None, "{not_a_remote}");
        }
    }

    #[test]
    fn keys_carry_the_folder_inside_the_repository() {
        assert_eq!(git_key("github.com/o/r", ""), "git:github.com/o/r");
        assert_eq!(git_key("github.com/o/r", "packages/ui"), "git:github.com/o/r#packages/ui");
        assert_eq!(git_key("github.com/o/r", "../elsewhere"), "git:github.com/o/r");
        assert_eq!(split_git_key("git:github.com/o/r#packages/ui"), Some(("github.com/o/r", Some("packages/ui"))));
        assert_eq!(split_git_key("git:github.com/o/r"), Some(("github.com/o/r", None)));
        assert_eq!(split_git_key("path:/a"), None);
        assert_eq!(path_key("/a/b"), "path:/a/b");
    }
}
