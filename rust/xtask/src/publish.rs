//! `cargo xtask publish-update`: builds a release of the in-app update feed
//! from a built `Eos.app` — its manifest, a pack of the chunks the feed does
//! not hold yet, the release notes and the signed pointer — into a folder laid
//! out as the feed is (`scripts/publish-update.mts`, without its upload).
//!
//! Nothing is uploaded and no server is contacted unless `--feed` names one:
//! the upload is the command printed at the end, for a person to run.
//!
//! ```text
//! cargo xtask publish-update <version> --app <Eos.app>
//!     (--first | --previous <manifest.json[.zst]> | --feed <https://…>)
//!     [--platform darwin-arm64] [--notes <file.md>] [--out <dir>]
//!     [--key-file <file> | --keychain] [--released-at <2026-11-11T00:00:00.000Z>] [--level <n>]
//!     [--rehearsal]
//! ```
//!
//! - The release this one is built against: `--previous` (a manifest on
//!   disk, as published or unpacked), `--feed` (read from a feed and checked
//!   against the app's keys) or `--first` (the platform's first release: the
//!   pack holds the whole bundle).
//! - The signing key (PKCS#8 DER in base64): `EOS_UPDATE_SIGNING_KEY`,
//!   `--key-file`, or — only when asked with `--keychain` — the Keychain item
//!   `eos-update-signing`. It must be one the app trusts
//!   (`UPDATE_PUBLIC_KEYS`); `--rehearsal` lifts that for a release that will
//!   never be uploaded.
//! - Output: `<out>` (default `target/updates/<version>`), emptied first.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use eos_contracts::update::{
    UPDATE_BUILD_INFO_FILE, UPDATE_PLATFORMS, UPDATE_PUBLIC_KEYS, UpdateBuildInfo, UpdateManifest, UpdatePlatform,
};
use eos_core::net::updates::{UpdateFeed, UpdateSignature};
use eos_domain::update::{
    compare_versions, manifest_problem, offered_release, parse_manifest, platform_name, platform_named,
};
use eos_update::{BuiltRelease, Ed25519Keys, HttpUpdateFeed, ReleaseInput, build_release, public_key_of};

const KEYCHAIN_SERVICE: &str = "eos-update-signing";
/// Where the feed's files live on its server (`update-server/README.md`).
const REMOTE_WWW: &str = "/opt/eos-updates/www";
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
const USAGE: &str = "usage: cargo xtask publish-update <version> --app <Eos.app> (--first | --previous <manifest> | --feed <url>) [--platform <p>] [--notes <file>] [--out <dir>] [--key-file <file> | --keychain] [--released-at <time>] [--level <n>] [--rehearsal]";

/// Where the release this one is built against comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Previous {
    First,
    File(PathBuf),
    Feed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum KeySource {
    /// `EOS_UPDATE_SIGNING_KEY`.
    Env,
    File(PathBuf),
    Keychain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Args {
    version: String,
    app: PathBuf,
    platform: UpdatePlatform,
    previous: Previous,
    notes: Option<PathBuf>,
    out: Option<PathBuf>,
    key: KeySource,
    released_at: Option<String>,
    level: Option<i32>,
    rehearsal: bool,
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut version = None;
    let (mut app, mut notes, mut out, mut released_at, mut level) = (None, None, None, None, None);
    let mut platform = UpdatePlatform::DarwinArm64;
    let mut previous = Vec::new();
    let mut key = Vec::new();
    let mut rehearsal = false;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().cloned().with_context(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--app" => app = Some(PathBuf::from(value()?)),
            "--notes" => notes = Some(PathBuf::from(value()?)),
            "--out" => out = Some(PathBuf::from(value()?)),
            "--released-at" => released_at = Some(value()?),
            "--level" => level = Some(value()?.parse().context("--level is a number")?),
            "--platform" => {
                let name = value()?;
                platform = platform_named(&name)
                    .with_context(|| format!("--platform must be one of {}", UPDATE_PLATFORMS.join(", ")))?;
            }
            "--first" => previous.push(Previous::First),
            "--previous" => previous.push(Previous::File(PathBuf::from(value()?))),
            "--feed" => previous.push(Previous::Feed(value()?)),
            "--key-file" => key.push(KeySource::File(PathBuf::from(value()?))),
            "--keychain" => key.push(KeySource::Keychain),
            "--rehearsal" => rehearsal = true,
            flag if flag.starts_with("--") => bail!("unknown option {flag}\n{USAGE}"),
            _ if version.is_none() => version = Some(arg.clone()),
            other => bail!("unexpected argument {other}\n{USAGE}"),
        }
    }
    let version =
        version.filter(|v| is_version(v)).with_context(|| format!("a version like 0.2.0 is required\n{USAGE}"))?;
    let app = app.with_context(|| format!("--app <Eos.app> is required\n{USAGE}"))?;
    if previous.len() != 1 {
        // Never guessed: built as a first release by mistake, a release would
        // pack the whole bundle and lose every chunk the feed already holds.
        bail!("say what this release is built against: exactly one of --first, --previous <manifest>, --feed <url>");
    }
    if key.len() > 1 {
        bail!("one signing key: --key-file or --keychain (or EOS_UPDATE_SIGNING_KEY)");
    }
    Ok(Args {
        version,
        app,
        platform,
        previous: previous.remove(0),
        notes,
        out,
        key: key.pop().unwrap_or(KeySource::Env),
        released_at,
        level,
        rehearsal,
    })
}

fn read_signing_key(source: &KeySource) -> anyhow::Result<String> {
    let key = match source {
        KeySource::Env => std::env::var("EOS_UPDATE_SIGNING_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
            .context("no signing key: set EOS_UPDATE_SIGNING_KEY, or pass --key-file or --keychain")?,
        KeySource::File(path) => fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?,
        KeySource::Keychain => {
            let out = Command::new("/usr/bin/security")
                .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
                .output()
                .context("running security")?;
            if !out.status.success() {
                bail!("the Keychain has no item {KEYCHAIN_SERVICE}");
            }
            String::from_utf8(out.stdout).context("the Keychain item is not text")?
        }
    };
    Ok(key.trim().to_owned())
}

/// A manifest file, as published (zstd) or unpacked.
fn read_manifest(path: &Path) -> anyhow::Result<UpdateManifest> {
    let raw = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let json = if raw.starts_with(&ZSTD_MAGIC) {
        let mut json = Vec::new();
        zstd::stream::read::Decoder::new(raw.as_slice())?.read_to_end(&mut json)?;
        json
    } else {
        raw
    };
    parse_manifest(&json).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// The release a feed serves now for `platform`, checked against `keys`.
fn feed_manifest(url: &str, platform: UpdatePlatform, keys: &Ed25519Keys) -> anyhow::Result<Option<UpdateManifest>> {
    let base = url.to_owned();
    let feed = HttpUpdateFeed::new(Arc::new(move || base.clone()))?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(async {
        let Some(signed) = feed.pointer(platform).await? else { return Ok(None) };
        let trusted = keys.verify(&signed.payload, &signed.signature);
        let Some(pointer) = offered_release(&signed, trusted, platform, "0.0.0")? else { return Ok(None) };
        Ok(Some(feed.manifest(&pointer.manifest).await?))
    })
}

/// `2026-11-11T09:30:00.123Z`, as JavaScript's `toISOString()` writes it.
fn iso_millis(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (since.as_secs(), since.subsec_millis());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// What a person runs to put the built release on the feed's server: the
/// immutable files first, never replacing one, then the pointer through a
/// temporary name, so installed apps see the release only once it is whole.
fn upload_commands(out: &Path, built: &BuiltRelease) -> String {
    let immutable: Vec<String> =
        built.files.iter().filter(|f| **f != built.pointer_path).map(|f| format!("./{f}")).collect();
    let pointer = &built.pointer_path;
    format!(
        "cd {out}\nrsync -aR --ignore-existing {files} \"$HOST:{REMOTE_WWW}/\"\nrsync -a {pointer} \"$HOST:{REMOTE_WWW}/{pointer}.tmp\"\nssh \"$HOST\" 'mv {REMOTE_WWW}/{pointer}.tmp {REMOTE_WWW}/{pointer}'",
        out = out.display(),
        files = immutable.join(" "),
    )
}

/// The app must say it is the release it is published as: an installed app
/// that updates into it waits for exactly this version to report in, and a
/// bundle without `update.json` would never update itself again.
fn check_build_info(app: &Path, version: &str, platform: UpdatePlatform) -> anyhow::Result<()> {
    let resources = match platform {
        UpdatePlatform::DarwinArm64 => "Contents/Resources",
        UpdatePlatform::Win32X64 | UpdatePlatform::Win32Arm64 => "resources",
    };
    let path = app.join(resources).join(UPDATE_BUILD_INFO_FILE);
    let raw = fs::read(&path)
        .with_context(|| format!("{} is missing: not a release build (EOS_UPDATE_CHANNEL=stable)", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).with_context(|| format!("{} is not JSON", path.display()))?;
    let info: UpdateBuildInfo = eos_contracts::parse(&value).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;
    if info.version.0 != version {
        bail!("the app says it is {}, not {version}", info.version.0);
    }
    if info.platform != platform {
        bail!("the app says it is for {}, not {}", platform_name(info.platform), platform_name(platform));
    }
    Ok(())
}

/// Builds the release described by `args` and returns it with its folder.
fn build(args: &Args) -> anyhow::Result<(BuiltRelease, PathBuf)> {
    check_build_info(&args.app, &args.version, args.platform)?;
    let signing_key = read_signing_key(&args.key)?;
    let public = public_key_of(&signing_key)?;
    if !UPDATE_PUBLIC_KEYS.contains(&public.as_str()) && !args.rehearsal {
        bail!("the signing key is not one the app trusts (UPDATE_PUBLIC_KEYS); --rehearsal builds with it anyway");
    }
    // A rehearsal's feed is signed by the rehearsal's key.
    let keys = if args.rehearsal { Ed25519Keys::new(&[&public])? } else { Ed25519Keys::trusted()? };
    let previous = match &args.previous {
        Previous::First => None,
        Previous::File(path) => Some(read_manifest(path)?),
        Previous::Feed(url) => feed_manifest(url, args.platform, &keys)?,
    };
    if let Some(previous) = &previous {
        if let Some(problem) = manifest_problem(previous) {
            bail!("the previous manifest is unsound: {problem}");
        }
        if previous.platform != args.platform {
            bail!("the previous manifest is for {}", platform_name(previous.platform));
        }
        if compare_versions(&args.version, &previous.version.0) != std::cmp::Ordering::Greater {
            bail!("the feed already has {}", previous.version.0);
        }
    }
    match &previous {
        Some(previous) => println!("building {} against {}", args.version, previous.version.0),
        None => println!("building {} (the feed's first release)", args.version),
    }

    let out = match &args.out {
        Some(out) => out.clone(),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/updates").join(&args.version),
    };
    if out.exists() {
        fs::remove_dir_all(&out).with_context(|| format!("emptying {}", out.display()))?;
    }
    let notes = match &args.notes {
        Some(path) => Some(fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?),
        None => None,
    };
    let released_at = args.released_at.clone().unwrap_or_else(|| iso_millis(SystemTime::now()));
    let built = build_release(&ReleaseInput {
        app_root: &args.app,
        version: &args.version,
        platform: args.platform,
        previous: previous.as_ref(),
        out_dir: &out,
        notes: notes.as_deref(),
        signing_key: &signing_key,
        released_at: &released_at,
        level: args.level,
    })?;
    Ok((built, out))
}

pub(crate) fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let started = Instant::now();
    let (built, out) = build(&args)?;
    println!(
        "built in {}s: {} new chunks, {} whole files, pack {:.1} MB",
        started.elapsed().as_secs(),
        built.new_chunks,
        built.whole_files,
        built.pack_bytes as f64 / 1_048_576.0
    );
    for file in &built.files {
        println!("  {file}");
    }
    if args.rehearsal {
        println!("a rehearsal: signed with a key the app may not trust — never upload it ({})", out.display());
        return Ok(());
    }
    println!("nothing was uploaded. To publish (HOST = the feed's server), pointer last:\n");
    println!("{}", upload_commands(&out, &built));
    Ok(())
}

#[cfg(test)]
mod tests {
    use eos_testkit::update::{read, release};

    use super::*;

    fn args(list: &[&str]) -> anyhow::Result<Args> {
        parse_args(&list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn what_a_release_is_built_against_is_never_guessed() {
        let err = args(&["0.2.0", "--app", "Eos.app"]).expect_err("no previous").to_string();
        assert!(err.contains("exactly one of --first, --previous"), "{err}");
        assert!(args(&["0.2.0", "--app", "Eos.app", "--first", "--feed", "https://feed.example"]).is_err());
        assert!(args(&["0.2", "--app", "Eos.app", "--first"]).is_err(), "a version is major.minor.patch");
        assert!(args(&["0.2.0", "--first"]).is_err(), "an app is required");
        assert!(args(&["0.2.0", "--app", "Eos.app", "--first", "--upload"]).is_err(), "there is no upload");

        let parsed = args(&["0.2.0", "--app", "Eos.app", "--previous", "m.json.zst", "--platform", "win32-x64"])
            .expect("parsed");
        assert_eq!(parsed.previous, Previous::File(PathBuf::from("m.json.zst")));
        assert_eq!(
            (parsed.platform, &parsed.key, parsed.rehearsal),
            (UpdatePlatform::Win32X64, &KeySource::Env, false)
        );
        // The Keychain is read only when asked for by name.
        assert_eq!(args(&["0.2.0", "--app", "a", "--first", "--keychain"]).expect("parsed").key, KeySource::Keychain);
    }

    #[test]
    fn the_time_reads_as_javascript_writes_it() {
        assert_eq!(iso_millis(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let time = UNIX_EPOCH + std::time::Duration::from_millis(1_794_355_200_123);
        assert_eq!(iso_millis(time), "2026-11-11T00:00:00.123Z");
    }

    #[test]
    fn the_release_to_build_against_is_read_from_a_feed_and_checked_against_the_keys() {
        let rel = release();
        let tmp = std::env::temp_dir().join(format!("eos-xtask-feed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        for file in ["releases/9.0.1/darwin-arm64.manifest.json.zst", "stable/darwin-arm64.json"] {
            let to = tmp.join(file);
            fs::create_dir_all(to.parent().expect("parent")).expect("dirs");
            let from =
                if file.starts_with("stable") { "pointer-9.0.1.json".to_owned() } else { format!("feed/{file}") };
            fs::write(to, read(&from)).expect("copy");
        }
        // A local stand-in for the feed, on a runtime of its own.
        let serving =
            tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("runtime");
        let server = serving.block_on(eos_testkit::update::server::FeedServer::serve(&tmp));

        let keys = Ed25519Keys::new(&[&rel.public_key]).expect("keys");
        let mac = UpdatePlatform::DarwinArm64;
        let manifest = feed_manifest(&server.base, mac, &keys).expect("read").expect("a release");
        assert_eq!(manifest.version.0, "9.0.1");
        assert!(
            feed_manifest(&server.base, UpdatePlatform::Win32X64, &keys).expect("read").is_none(),
            "nothing published yet"
        );
        let strangers = Ed25519Keys::trusted().expect("the app's keys");
        let refused = feed_manifest(&server.base, mac, &strangers).expect_err("signed by another key");
        assert_eq!(refused.to_string(), "the release pointer's signature does not verify");
        drop(server);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// The command as a person runs it — key from a file, the previous
    /// manifest as the feed publishes it — writes the bytes the TypeScript
    /// publisher wrote for the same bundle (`rust/fixtures/update`).
    #[test]
    fn the_command_writes_what_the_typescript_publisher_writes() {
        let rel = release();
        let tmp = std::env::temp_dir().join(format!("eos-xtask-publish-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("dir");
        let text = |path: PathBuf| path.to_string_lossy().into_owned();
        fs::write(tmp.join("key"), format!("{}\n", rel.private_key)).expect("key");
        fs::write(tmp.join("notes.md"), "first\n").expect("notes");
        fs::write(tmp.join("previous.zst"), read("feed/releases/9.0.0/darwin-arm64.manifest.json.zst"))
            .expect("previous");
        rel.write_bundle(&tmp.join("1/Eos.app"), false);
        rel.write_bundle(&tmp.join("2/Eos.app"), true);
        let common = |version: &str, app: &str| {
            vec![
                version.to_owned(),
                "--app".into(),
                text(tmp.join(app)),
                "--key-file".into(),
                text(tmp.join("key")),
                "--released-at".into(),
                rel.released_at.clone(),
                "--out".into(),
                text(tmp.join("out").join(version)),
            ]
        };

        // The fixture key is not one the app trusts: refused unless it is a rehearsal.
        let mut first = common("9.0.0", "1/Eos.app");
        first.extend(["--first".into(), "--notes".into(), text(tmp.join("notes.md"))]);
        let refused = build(&parse_args(&first).expect("parsed")).expect_err("an untrusted key");
        assert!(refused.to_string().contains("not one the app trusts"), "{refused}");
        first.push("--rehearsal".into());
        let (built, out) = build(&parse_args(&first).expect("parsed")).expect("built");
        for (file, fixture) in [
            ("packs/darwin-arm64/9.0.0.pack", "feed/packs/darwin-arm64/9.0.0.pack"),
            ("releases/9.0.0/darwin-arm64.manifest.json.zst", "feed/releases/9.0.0/darwin-arm64.manifest.json.zst"),
            ("notes/9.0.0.md", "feed/notes/9.0.0.md"),
            ("stable/darwin-arm64.json", "pointer-9.0.0.json"),
        ] {
            assert!(fs::read(out.join(file)).expect(file) == read(fixture), "{file}");
        }
        let commands = upload_commands(&out, &built);
        assert!(commands.contains("--ignore-existing ./packs/darwin-arm64/9.0.0.pack ./releases/9.0.0/darwin-arm64.manifest.json.zst ./notes/9.0.0.md "), "{commands}");
        assert!(
            commands.ends_with(
                "'mv /opt/eos-updates/www/stable/darwin-arm64.json.tmp /opt/eos-updates/www/stable/darwin-arm64.json'"
            ),
            "{commands}"
        );

        let mut second = common("9.0.1", "2/Eos.app");
        second.extend(["--previous".into(), text(tmp.join("previous.zst")), "--rehearsal".into()]);
        let (_, out) = build(&parse_args(&second).expect("parsed")).expect("built");
        for (file, fixture) in [
            ("packs/darwin-arm64/9.0.1.pack", "feed/packs/darwin-arm64/9.0.1.pack"),
            ("releases/9.0.1/darwin-arm64.manifest.json.zst", "feed/releases/9.0.1/darwin-arm64.manifest.json.zst"),
            ("stable/darwin-arm64.json", "pointer-9.0.1.json"),
        ] {
            assert!(fs::read(out.join(file)).expect(file) == read(fixture), "{file}");
        }

        // The app must be the release it is published as: the installed app waits for that version.
        let mut misnamed = common("9.0.2", "2/Eos.app");
        misnamed.extend(["--previous".into(), text(tmp.join("previous.zst")), "--rehearsal".into()]);
        let refused = build(&parse_args(&misnamed).expect("parsed")).expect_err("another version inside");
        assert_eq!(refused.to_string(), "the app says it is 9.0.1, not 9.0.2");
        fs::remove_file(tmp.join("2/Eos.app/Contents/Resources/update.json")).expect("remove");
        let refused = build(&parse_args(&second).expect("parsed")).expect_err("not a release build");
        assert!(refused.to_string().contains("not a release build"), "{refused}");
        rel.write_bundle(&tmp.join("3/Eos.app"), true);

        // A release that is not newer than the one it is built against is refused.
        fs::write(tmp.join("after.json"), read("manifest-9.0.1.json")).expect("a later manifest");
        let mut stale = common("9.0.1", "3/Eos.app");
        stale.extend(["--previous".into(), text(tmp.join("after.json")), "--rehearsal".into()]);
        let refused = build(&parse_args(&stale).expect("parsed")).expect_err("not newer");
        assert_eq!(refused.to_string(), "the feed already has 9.0.1");
        let _ = fs::remove_dir_all(&tmp);
    }
}
