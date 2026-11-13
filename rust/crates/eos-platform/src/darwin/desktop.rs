//! Handing paths to Finder and editors through `open(1)`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::error::Error;
use crate::host::{DefaultApp, Desktop, OpenTarget};
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

/// Asks LaunchServices, through the system's JavaScript bridge, which app
/// opens the file given as the script's argument. Prints the app's path, its
/// identifier and its display name on three lines; nothing when there is none.
const DEFAULT_APP_SCRIPT: &str = r"ObjC.import('AppKit');
function run(argv) {
  var app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));
  if (app.isNil()) return '';
  var id = '', name = '';
  var bundle = $.NSBundle.bundleWithURL(app);
  if (!bundle.isNil()) {
    var bid = bundle.bundleIdentifier;
    if (!bid.isNil()) id = ObjC.unwrap(bid);
    var info = bundle.infoDictionary;
    var shown = info.objectForKey('CFBundleDisplayName');
    if (shown.isNil()) shown = info.objectForKey('CFBundleName');
    if (!shown.isNil()) name = ObjC.unwrap(shown);
  }
  if (!name) name = ObjC.unwrap(app.URLByDeletingPathExtension.lastPathComponent);
  return ObjC.unwrap(app.path) + '\n' + id + '\n' + name;
}";

/// The three lines [`DEFAULT_APP_SCRIPT`] prints. The identifier may be empty.
fn parse_default_app(out: &str) -> Option<DefaultApp> {
    let mut lines = out.trim_end_matches('\n').split('\n');
    let bundle_path = lines.next().map(str::trim).filter(|l| !l.is_empty())?;
    let bundle_id = lines.next()?.trim();
    let app_name = lines.next().map(str::trim).filter(|l| !l.is_empty())?;
    Some(DefaultApp {
        bundle_path: bundle_path.to_owned(),
        bundle_id: bundle_id.to_owned(),
        app_name: app_name.to_owned(),
    })
}

/// The `.icns` file an app names in its `Info.plist`, else the first one in its resources.
fn icon_file(bundle_path: &Path) -> Option<PathBuf> {
    let resources = bundle_path.join("Contents").join("Resources");
    let named = tool::run_ok(
        "defaults",
        Command::new("/usr/bin/defaults")
            .arg("read")
            .arg(bundle_path.join("Contents").join("Info"))
            .arg("CFBundleIconFile"),
        None,
        TIMEOUT,
    )
    .ok()
    .map(|out| out.stdout.trim().to_owned())
    .filter(|name| !name.is_empty());
    if let Some(name) = named {
        let file = resources.join(if name.ends_with(".icns") { name } else { format!("{name}.icns") });
        if file.exists() {
            return Some(file);
        }
    }
    let mut icons: Vec<PathBuf> = std::fs::read_dir(&resources)
        .ok()?
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("icns")))
        .collect();
    icons.sort();
    icons.into_iter().next()
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

    fn default_app(&self, file: &Path) -> Option<DefaultApp> {
        let out = tool::run_ok(
            "osascript",
            Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", DEFAULT_APP_SCRIPT]).arg(file),
            None,
            TIMEOUT,
        )
        .ok()?;
        parse_default_app(&out.stdout)
    }

    fn render_app_icon(&self, bundle_path: &Path, out: &Path) -> Result<(), Error> {
        let icns =
            icon_file(bundle_path).ok_or(Error::Tool { tool: "sips", detail: "the app has no icon file".into() })?;
        tool::run_ok(
            "sips",
            Command::new("/usr/bin/sips")
                .args(["-s", "format", "png", "-z", "64", "64"])
                .arg(icns)
                .arg("--out")
                .arg(out),
            None,
            TIMEOUT,
        )
        .map(drop)
    }

    fn render_scaled_image(&self, image: &Path, width: u32, height: u32, out: &Path) -> Result<(), Error> {
        let (width, height) = (width.to_string(), height.to_string());
        tool::run_ok(
            "sips",
            Command::new("/usr/bin/sips")
                .args(["-s", "format", "png", "-z", &height, &width])
                .arg(image)
                .arg("--out")
                .arg(out),
            None,
            TIMEOUT,
        )
        .map(drop)
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
    fn the_default_app_answer_is_three_lines() {
        let app =
            parse_default_app("/System/Applications/TextEdit.app\ncom.apple.TextEdit\nTextEdit\n").expect("an app");
        assert_eq!(
            (app.bundle_path.as_str(), app.bundle_id.as_str(), app.app_name.as_str()),
            ("/System/Applications/TextEdit.app", "com.apple.TextEdit", "TextEdit")
        );
        assert_eq!(parse_default_app("/Apps/Odd.app\n\nOdd\n").map(|a| a.bundle_id), Some(String::new()));
        assert_eq!(parse_default_app(""), None);
        assert_eq!(parse_default_app("/Apps/Half.app\n"), None);
    }

    #[test]
    fn an_app_that_is_not_there_is_not_installed() {
        assert!(!MacDesktop.app_installed("Eos Test App That Does Not Exist"));
    }
}
