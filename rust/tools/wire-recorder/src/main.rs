//! `wire-recorder record | replay | coverage` — see `rust/fixtures/README.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::Value;
use wire_recorder::coverage::{self, Notes, RouteTable};
use wire_recorder::diff::{Report, StepReport, diff};
use wire_recorder::http::{Endpoint, HttpTarget};
use wire_recorder::inproc::RustTarget;
use wire_recorder::known::Known;
use wire_recorder::model::{Exchange, Recording, Scenario, Step};
use wire_recorder::normalize::Normalizer;
use wire_recorder::renumber::Renumber;
use wire_recorder::runner::{Outcome, Runner, Settings};
use wire_recorder::target::Target;
use wire_recorder::vars::Vars;

/// A data folder holding this file is a copy of a real one.
const REAL_DATA_MARKER: &str = "REAL_DATA";

const USAGE: &str = "\
usage:
  wire-recorder record   --scenarios DIR --out DIR --rules FILE [--routes FILE] TARGET [--read-only] [--lenient]
  wire-recorder replay   --recordings DIR --rules FILE TARGET [--known FILE] [--verbose] [--redact]
  wire-recorder coverage --routes FILE --recordings DIR --notes FILE --out FILE
  wire-recorder seed     --home DIR --sql FILE [--var NAME=VALUE]   migrate DIR/state.db, then run FILE on it

TARGET:
  --rust-home DIR    the Rust core, built in process on this data folder (instead of --api / --socket)
  --as-phone         with --rust-home: every route the phone may call is asked as the phone
                     (through the relay it answers what the dashboard gets)
  --api URL          the API listener, http://host:port
  --raw URL          the raw-content listener
  --socket PATH      the control socket
  --token-file FILE  holds the ui-token
  --var NAME=VALUE   a value scenarios use as {NAME} (repeatable); written back as {NAME} in recordings
  --only A,B         only these scenarios
  --settle-ms N      quiet time that ends a step's stream frames (default 250)

replay --known FILE  differences that are expected, each with its reason: they do not fail the replay
replay --redact      print where answers differ, never their values (for recordings of real data)
record --read-only   only scenarios marked read_only (safe on a real data folder)
record --lenient     an unexpected status is recorded with a warning instead of stopping

--real-data          the target serves a real data folder: only read_only scenarios run and
                     every request that is not a GET or HEAD is refused. Also on when the
                     folder given as --var home=DIR holds a file named REAL_DATA.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((command, rest)) => Args::parse(rest).and_then(|args| match command.as_str() {
            "record" => record(&args),
            "replay" => replay(&args),
            "coverage" => cover(&args),
            "seed" => seed(&args),
            other => bail!("unknown command {other}\n\n{USAGE}"),
        }),
        None => Err(anyhow::anyhow!("{USAGE}")),
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("wire-recorder: {error:#}");
            ExitCode::from(2)
        }
    }
}

/// `--name value` pairs and flags.
struct Args {
    values: BTreeMap<String, Vec<String>>,
}

impl Args {
    const FLAGS: [&str; 6] = ["read-only", "lenient", "verbose", "real-data", "redact", "as-phone"];

    fn parse(args: &[String]) -> anyhow::Result<Self> {
        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            let name = arg.strip_prefix("--").with_context(|| format!("unexpected argument {arg}\n\n{USAGE}"))?;
            let value = if Self::FLAGS.contains(&name) {
                String::new()
            } else {
                rest.next().with_context(|| format!("--{name} needs a value"))?.clone()
            };
            values.entry(name.to_owned()).or_default().push(value);
        }
        Ok(Self { values })
    }

    fn flag(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|v| v.last()).map(String::as_str)
    }

    fn path(&self, name: &str) -> anyhow::Result<PathBuf> {
        self.get(name).map(PathBuf::from).with_context(|| format!("--{name} is required\n\n{USAGE}"))
    }

    /// The Rust core in process when `--rust-home` is given, else a daemon behind HTTP.
    fn target(&self) -> anyhow::Result<(Box<dyn Target + Send>, Option<RustTarget>)> {
        if let Some(home) = self.get("rust-home") {
            let rust = RustTarget::start(Path::new(home))?.as_phone(self.flag("as-phone"));
            return Ok((Box::new(rust.clone()), Some(rust)));
        }
        let socket = self.get("socket").map(|path| Endpoint::Unix(PathBuf::from(path)));
        let api = match self.get("api") {
            Some(url) => Endpoint::from_url(url)?,
            None => socket.clone().context("--api (or --socket) is required")?,
        };
        Ok((Box::new(HttpTarget { api, raw: self.get("raw").map(Endpoint::from_url).transpose()?, socket }), None))
    }

    fn settings(&self) -> anyhow::Result<Settings> {
        // The Rust core keeps its token where the daemon does.
        let in_home = self.get("rust-home").map(|home| format!("{home}/ui-token"));
        let token = match self.get("token-file").map(str::to_owned).or(in_home) {
            Some(file) => {
                Some(std::fs::read_to_string(&file).with_context(|| format!("reading {file}"))?.trim().to_owned())
            }
            None => None,
        };
        let settle = self.get("settle-ms").map(str::parse).transpose().context("--settle-ms")?.unwrap_or(250);
        Ok(Settings {
            token,
            settle: Duration::from_millis(settle),
            wait_timeout: Duration::from_secs(10),
            report_missing_frames: false,
            real_data: self.real_data()?,
        })
    }

    /// Said on the command line, or marked in the data folder itself.
    fn real_data(&self) -> anyhow::Result<bool> {
        let marked = self.known()?.get("home").is_some_and(|home| Path::new(home).join(REAL_DATA_MARKER).exists());
        Ok(self.flag("real-data") || marked)
    }

    fn known(&self) -> anyhow::Result<BTreeMap<String, String>> {
        self.values
            .get("var")
            .into_iter()
            .flatten()
            .map(|pair| {
                let (name, value) =
                    pair.split_once('=').with_context(|| format!("--var {pair}: expected NAME=VALUE"))?;
                Ok((name.to_owned(), value.to_owned()))
            })
            .collect()
    }

    fn only(&self, name: &str) -> bool {
        self.get("only").is_none_or(|list| list.split(',').any(|wanted| wanted == name))
    }
}

fn vars(known: &BTreeMap<String, String>) -> Vars {
    let mut vars = Vars::default();
    for (name, value) in known {
        vars.set(name, Value::String(value.clone()));
    }
    vars
}

/// Files with this extension in `dir`, by name.
fn files(dir: &Path, extension: &str) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == extension)
            && let Some(name) = path.file_stem().and_then(|s| s.to_str())
        {
            out.push((name.to_owned(), path));
        }
    }
    out.sort();
    Ok(out)
}

fn what(step: &Step) -> String {
    match (&step.request, &step.open, &step.close, &step.join) {
        (Some(request), ..) => request.clone(),
        (_, Some(name), ..) => format!("open stream {name}"),
        (_, _, Some(name), _) => format!("close stream {name}"),
        (.., Some(name)) => format!("answer of {name}"),
        _ => String::new(),
    }
}

/// The route name rules match on: the request as the scenario wrote it.
fn rule_route(step: &Step, steps: &[&Step]) -> String {
    match (&step.request, &step.open, &step.join) {
        (Some(request), ..) => request.clone(),
        (_, Some(_), _) => "OPEN /stream".to_owned(),
        // The answer of a detached request is that request's.
        (_, _, Some(name)) => {
            steps.iter().find(|s| s.name == *name).and_then(|s| s.request.clone()).unwrap_or_default()
        }
        _ => "CLOSE /stream".to_owned(),
    }
}

fn record(args: &Args) -> anyhow::Result<ExitCode> {
    let out = args.path("out")?;
    let known = args.known()?;
    let routes = args.get("routes").map(|p| RouteTable::load(Path::new(p))).transpose()?;
    let (read_only, lenient) = (args.flag("read-only") || args.real_data()?, args.flag("lenient"));
    let (mut target, _) = args.target()?;
    std::fs::create_dir_all(&out)?;

    let mut warnings = 0;
    for (name, path) in files(&args.path("scenarios")?, "toml")? {
        let scenario = Scenario::load(&path)?;
        if !args.only(&name) || (read_only && !scenario.read_only) {
            continue;
        }
        let mut normalizer = Normalizer::load(&args.path("rules")?, &known)?;
        let mut runner = Runner::new(target.as_mut(), args.settings()?, vars(&known));
        let mut exchanges = Vec::new();
        let (mut answered, mut skipped) = (0, 0);
        for step in &scenario.steps {
            let outcome = match runner.step(step).with_context(|| format!("{name} / {}", step.name)) {
                Ok(outcome) => outcome,
                // Keep what was recorded so far: it shows where the scenario went wrong.
                Err(error) if lenient => {
                    eprintln!("warning: {error:#}; {name} stops here");
                    warnings += 1;
                    break;
                }
                Err(error) => return Err(error),
            };
            let (route, response) = match outcome {
                Outcome::Skipped { missing } => {
                    if !lenient && !step.optional {
                        bail!("{name} / {}: {{{missing}}} was never captured", step.name);
                    }
                    skipped += 1;
                    (None, Value::Null)
                }
                Outcome::NotServed { method, path } => {
                    bail!("{name} / {}: the target does not serve {method} {path}", step.name)
                }
                Outcome::Answered { response, method, path } => {
                    let status = response.get("status").and_then(Value::as_u64);
                    if let Some(expected) = step.status
                        && status != Some(u64::from(expected))
                    {
                        let message = format!(
                            "{name} / {}: expected {expected}, got {} — {}",
                            step.name,
                            show(status),
                            excerpt(&response)
                        );
                        if !lenient {
                            bail!(message);
                        }
                        eprintln!("warning: {message}");
                        warnings += 1;
                    }
                    answered += 1;
                    let route =
                        routes.as_ref().and_then(|t| t.find(step.via, &method, &path)).map(coverage::Route::label);
                    let all: Vec<&Step> = scenario.steps.iter().collect();
                    (route, normalizer.normalize(&rule_route(step, &all), &scenario.record_headers, response))
                }
            };
            exchanges.push(Exchange { step: step.clone(), route, response });
        }
        let recording = Recording {
            scenario: name.clone(),
            about: scenario.about,
            record_headers: scenario.record_headers,
            exchanges,
        };
        recording.save(&out.join(format!("{name}.json")))?;
        println!(
            "{name}: {answered} steps recorded{}",
            if skipped > 0 { format!(", {skipped} skipped") } else { String::new() }
        );
    }
    if warnings > 0 {
        println!("{warnings} warnings");
    }
    Ok(ExitCode::SUCCESS)
}

fn replay(args: &Args) -> anyhow::Result<ExitCode> {
    let known = args.known()?;
    let (mut target, rust) = args.target()?;
    let (verbose, redact) = (args.flag("verbose"), args.flag("redact"));
    let listed_differences =
        args.get("known").map(|file| Known::load(Path::new(file))).transpose()?.unwrap_or_default();
    let (mut steps, mut failed, mut listed, mut later, mut stale) = (0, 0, 0, 0, 0);
    // Scenarios share one data folder: once a write was not served, what later
    // reads show is no longer what the recording saw.
    let mut unserved_write = false;
    for (name, path) in files(&args.path("recordings")?, "json")? {
        if !args.only(&name) {
            continue;
        }
        let recording = Recording::load(&path)?;
        let mut normalizer = Normalizer::load(&args.path("rules")?, &known)?;
        // A frame the answering side never sends is a difference to judge, not a reason to stop.
        let settings = Settings { report_missing_frames: true, ..args.settings()? };
        let mut runner = Runner::new(target.as_mut(), settings, vars(&known));
        let mut report = Report { scenario: name.clone(), ..Report::default() };
        // The two sides number generated ids apart once a step is skipped; see `renumber`.
        let (mut recorded_ids, mut answered_ids) = (Renumber::default(), Renumber::default());
        // A step that was not served captures nothing: the steps that needed
        // its ids cannot run either, and are not differences.
        let mut starved = false;
        for exchange in &recording.exchanges {
            let step = &exchange.step;
            let outcome = runner.step(step).with_context(|| format!("{name} / {}", step.name))?;
            let actual = match outcome {
                Outcome::NotServed { method, path } => {
                    starved |= !step.capture.is_empty();
                    unserved_write |= !step.only_reads();
                    report.not_served.push(format!("{:<28} {method} {path}", step.name));
                    continue;
                }
                Outcome::Skipped { missing } if starved && !exchange.response.is_null() => {
                    unserved_write |= !step.only_reads();
                    report.not_served.push(format!("{:<28} needs {{{missing}}} from a step not served yet", step.name));
                    continue;
                }
                Outcome::Skipped { .. } => Value::Null,
                Outcome::Answered { response, .. } => {
                    let all: Vec<&Step> = recording.exchanges.iter().map(|e| &e.step).collect();
                    normalizer.normalize(&rule_route(step, &all), &recording.record_headers, response)
                }
            };
            let mut reasons: Vec<String> = Vec::new();
            let mut differences = diff(&recorded_ids.apply(&exchange.response), &answered_ids.apply(&actual));
            differences.retain(|d| match listed_differences.reason(&name, &step.name, &d.path) {
                Some(reason) => {
                    if !reasons.iter().any(|r| r == reason) {
                        reasons.push(reason.to_owned());
                    }
                    false
                }
                None => true,
            });
            if unserved_write && !differences.is_empty() {
                report.stale.push(format!("{:<28} {}", step.name, what(step)));
                continue;
            }
            report.steps.push(StepReport { step: step.name.clone(), what: what(step), differences, known: reasons });
        }
        steps += report.steps.len();
        failed += report.failed();
        listed += report.known();
        later += report.not_served.len();
        stale += report.stale.len();
        print!("{}", report.render(verbose, redact));
    }
    if let Some(rust) = rust {
        rust.stop();
    }
    print!("\n{} of {steps} steps match", steps - failed - listed);
    if listed > 0 {
        print!("; {listed} differ as listed");
    }
    if failed > 0 {
        print!("; {failed} DIFFER");
    }
    if stale > 0 {
        print!("; {stale} read what an unserved write changes");
    }
    match later {
        0 => println!(),
        n => println!("; {n} wait for routes not served yet"),
    }
    Ok(if failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

fn cover(args: &Args) -> anyhow::Result<ExitCode> {
    let table = RouteTable::load(&args.path("routes")?)?;
    let notes = Notes::load(&args.path("notes")?)?;
    let recordings = files(&args.path("recordings")?, "json")?
        .iter()
        .map(|(_, path)| Recording::load(path))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (text, totals) = coverage::table(&table, &recordings, &notes);
    let out = args.path("out")?;
    std::fs::write(&out, text).with_context(|| format!("writing {}", out.display()))?;
    println!(
        "{} routes: {} recorded, {} errors only, {} not recorded ({} unexplained); {} of {} ROUTES keys; {} steps",
        totals.routes,
        totals.recorded,
        totals.errors_only,
        totals.not_recorded,
        totals.unexplained,
        totals.keys_recorded,
        totals.keys,
        totals.steps
    );
    Ok(if totals.unexplained == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

/// Gives a data folder its schema and the invented rows, as the recording
/// run did: the rows go in while nothing runs on the folder, so the next
/// start meets them as it would after a crash.
fn seed(args: &Args) -> anyhow::Result<ExitCode> {
    let home = args.path("home")?;
    let file = args.path("sql")?;
    let mut sql = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
    for (name, value) in args.known()? {
        sql = sql.replace(&format!("{{{name}}}"), &value);
    }
    std::fs::create_dir_all(&home)?;
    let (db, _) = eos_kit_sqlite::Db::open(home.join("state.db"), eos_kit_sqlite::Options::default(), 0)?;
    db.maintain(move |conn| conn.execute_batch(&sql).map_err(eos_kit_sqlite::Error::from))?;
    db.close();
    Ok(ExitCode::SUCCESS)
}

fn show(status: Option<u64>) -> String {
    status.map_or_else(|| "no status".to_owned(), |s| s.to_string())
}

fn excerpt(response: &Value) -> String {
    let body = response.get("json").map(Value::to_string).or_else(|| response.get("text").map(Value::to_string));
    body.unwrap_or_default().chars().take(300).collect()
}
