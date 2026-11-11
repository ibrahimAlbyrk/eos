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
use wire_recorder::model::{Exchange, Recording, Scenario, Step};
use wire_recorder::normalize::Normalizer;
use wire_recorder::runner::{Outcome, Runner, Settings};
use wire_recorder::vars::Vars;

/// A data folder holding this file is a copy of a real one.
const REAL_DATA_MARKER: &str = "REAL_DATA";

const USAGE: &str = "\
usage:
  wire-recorder record   --scenarios DIR --out DIR --rules FILE [--routes FILE] TARGET [--read-only] [--lenient]
  wire-recorder replay   --recordings DIR --rules FILE TARGET [--verbose]
  wire-recorder coverage --routes FILE --recordings DIR --notes FILE --out FILE

TARGET:
  --api URL          the API listener, http://host:port
  --raw URL          the raw-content listener
  --socket PATH      the control socket
  --token-file FILE  holds the ui-token
  --var NAME=VALUE   a value scenarios use as {NAME} (repeatable); written back as {NAME} in recordings
  --only A,B         only these scenarios
  --settle-ms N      quiet time that ends a step's stream frames (default 250)

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
    const FLAGS: [&str; 4] = ["read-only", "lenient", "verbose", "real-data"];

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

    fn target(&self) -> anyhow::Result<HttpTarget> {
        let socket = self.get("socket").map(|path| Endpoint::Unix(PathBuf::from(path)));
        let api = match self.get("api") {
            Some(url) => Endpoint::from_url(url)?,
            None => socket.clone().context("--api (or --socket) is required")?,
        };
        Ok(HttpTarget { api, raw: self.get("raw").map(Endpoint::from_url).transpose()?, socket })
    }

    fn settings(&self) -> anyhow::Result<Settings> {
        let token = match self.get("token-file") {
            Some(file) => {
                Some(std::fs::read_to_string(file).with_context(|| format!("reading {file}"))?.trim().to_owned())
            }
            None => None,
        };
        let settle = self.get("settle-ms").map(str::parse).transpose().context("--settle-ms")?.unwrap_or(250);
        Ok(Settings {
            token,
            settle: Duration::from_millis(settle),
            wait_timeout: Duration::from_secs(10),
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
    let mut target = args.target()?;
    std::fs::create_dir_all(&out)?;

    let mut warnings = 0;
    for (name, path) in files(&args.path("scenarios")?, "toml")? {
        let scenario = Scenario::load(&path)?;
        if !args.only(&name) || (read_only && !scenario.read_only) {
            continue;
        }
        let mut normalizer = Normalizer::load(&args.path("rules")?, &known)?;
        let mut runner = Runner::new(&mut target, args.settings()?, vars(&known));
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
    let mut target = args.target()?;
    let (mut steps, mut failed) = (0, 0);
    for (name, path) in files(&args.path("recordings")?, "json")? {
        if !args.only(&name) {
            continue;
        }
        let recording = Recording::load(&path)?;
        let mut normalizer = Normalizer::load(&args.path("rules")?, &known)?;
        let mut runner = Runner::new(&mut target, args.settings()?, vars(&known));
        let mut report = Report { scenario: name.clone(), steps: Vec::new() };
        for exchange in &recording.exchanges {
            let step = &exchange.step;
            let outcome = runner.step(step).with_context(|| format!("{name} / {}", step.name))?;
            let actual = match outcome {
                Outcome::Skipped { .. } => Value::Null,
                Outcome::Answered { response, .. } => {
                    let all: Vec<&Step> = recording.exchanges.iter().map(|e| &e.step).collect();
                    normalizer.normalize(&rule_route(step, &all), &recording.record_headers, response)
                }
            };
            report.steps.push(StepReport {
                step: step.name.clone(),
                what: what(step),
                differences: diff(&exchange.response, &actual),
            });
        }
        steps += report.steps.len();
        failed += report.failed();
        print!("{}", report.render(args.flag("verbose")));
    }
    println!("\n{} of {steps} steps match", steps - failed);
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

fn show(status: Option<u64>) -> String {
    status.map_or_else(|| "no status".to_owned(), |s| s.to_string())
}

fn excerpt(response: &Value) -> String {
    let body = response.get("json").map(Value::to_string).or_else(|| response.get("text").map(Value::to_string));
    body.unwrap_or_default().chars().take(300).collect()
}
