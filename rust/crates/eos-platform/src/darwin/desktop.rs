//! Handing paths to Finder and editors through `open(1)`.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::error::Error;
use crate::host::{Desktop, OpenTarget};
use crate::paths::home_dir;
use crate::tool;

const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub(crate) struct MacDesktop;

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `open` arguments per target: the file manager reveals (`-R`); an app with a
/// line URL opens at the line; any other app just opens the path.
pub fn open_in_argv(target: OpenTarget<'_>, path: &str, line: Option<u32>, column: Option<u32>) -> Vec<String> {
    match target {
        OpenTarget::FileManager => vec!["-R".to_owned(), path.to_owned()],
        OpenTarget::App { line_url_scheme: Some(scheme), .. } if line.is_some_and(|l| l > 0) => {
            let encoded: Vec<String> = path.split('/').map(encode_uri_component).collect();
            let line = line.unwrap_or_default();
            let column = column.filter(|c| *c > 0).map(|c| format!(":{c}")).unwrap_or_default();
            vec![format!("{scheme}://file{}:{line}{column}", encoded.join("/"))]
        }
        OpenTarget::App { name, .. } => vec!["-a".to_owned(), name.to_owned(), path.to_owned()],
    }
}

fn open(args: &[String]) -> Result<(), Error> {
    tool::run_ok("open", Command::new("/usr/bin/open").args(args), None, TIMEOUT).map(drop)
}

impl Desktop for MacDesktop {
    fn open_path(&self, path: &Path) -> Result<(), Error> {
        open(&[path.to_string_lossy().into_owned()])
    }

    fn reveal_path(&self, path: &Path) -> Result<(), Error> {
        open(&["-R".to_owned(), path.to_string_lossy().into_owned()])
    }

    fn open_in(
        &self,
        target: OpenTarget<'_>,
        path: &Path,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), Error> {
        open(&open_in_argv(target, &path.to_string_lossy(), line, column))
    }

    // In /Applications or ~/Applications.
    fn app_installed(&self, app_name: &str) -> bool {
        let bundle = format!("{app_name}.app");
        Path::new("/Applications").join(&bundle).exists()
            || home_dir().is_some_and(|home| home.join("Applications").join(&bundle).exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VSCODE: OpenTarget<'_> = OpenTarget::App { name: "Visual Studio Code", line_url_scheme: Some("vscode") };
    const ZED: OpenTarget<'_> = OpenTarget::App { name: "Zed", line_url_scheme: None };

    #[test]
    fn the_file_manager_reveals() {
        assert_eq!(open_in_argv(OpenTarget::FileManager, "/a/b.txt", Some(3), None), ["-R", "/a/b.txt"]);
    }

    #[test]
    fn an_editor_with_a_line_url_opens_at_the_line() {
        assert_eq!(open_in_argv(VSCODE, "/a/b c/é#.ts", Some(12), None), ["vscode://file/a/b%20c/%C3%A9%23.ts:12"]);
        assert_eq!(open_in_argv(VSCODE, "/a/b.ts", Some(12), Some(4)), ["vscode://file/a/b.ts:12:4"]);
        assert_eq!(open_in_argv(VSCODE, "/a/b.ts", None, Some(4)), ["-a", "Visual Studio Code", "/a/b.ts"]);
    }

    #[test]
    fn any_other_editor_opens_the_file_only() {
        assert_eq!(open_in_argv(ZED, "/a/b.ts", Some(12), Some(4)), ["-a", "Zed", "/a/b.ts"]);
    }

    #[test]
    fn an_app_that_is_not_there_is_not_installed() {
        assert!(!MacDesktop.app_installed("Eos Test App That Does Not Exist"));
    }
}
