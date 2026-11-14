//! `wire-recorder replay | coverage | seed` — see `fixtures/README.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::Value;
use wire_recorder::coverage::{self, Notes, RouteTable};
use wire_recorder::diff::{Report, StepReport, diff};
use wire_recorder::inproc::RustTarget;
use wire_recorder::known::Known;
use wire_recorder::model::{Recording, Step};
use wire_recorder::normalize::Normalizer;
use wire_recorder::renumber::Renumber;
use wire_recorder::runner::{Outcome, Runner, Settings};
use wire_recorder::vars::Vars;

/// A data folder holding this file is a copy of a real one.
const REAL_DATA_MARKER: &str = "REAL_DATA";

const USAGE: &str = "\
usage:
  wire-recorder replay   --recordings DIR --rules FILE --rust-home DIR [--known FILE] [--verbose] [--redact]
  wire-recorder coverage --routes FILE --recordings DIR --notes FILE --out FILE
  wire-recorder seed     --home DIR --sql FILE [--var NAME=VALUE]   migrate DIR/state.db, then run FILE on it

replay:
  --rust-home DIR    the Rust core, built in process on this data folder
  --as-phone         every route the phone may call is asked as the phone
                     (through the relay it answers what the dashboard gets)
  --var NAME=VALUE   a value recordings use as {NAME} (repeatable)
  --only A,B         only these recordings
  --settle-ms N      quiet time that ends a step's stream frames (default 250)
  --known FILE       differences that are expected, each with its reason: they do not fail the replay
  --redact           print where answers differ, never their values (for recordings of real data)
  --real-data        the data folder is a real one: every request that is not a GET or HEAD is
                     refused. Also on when the folder given as --var home=DIR holds a file
                     named REAL_DATA.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((command, rest)) => Args::parse(rest).and_then(|args| match command.as_str() {
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
    const FLAGS: [&str; 4] = ["verbose", "real-data", "redact", "as-phone"];

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

    /// The Rust core, in process on the data folder `--rust-home` names.
    fn target(&self) -> anyhow::Result<RustTarget> {
        let home = self.path("rust-home")?;
        Ok(RustTarget::start(&home)?.as_phone(self.flag("as-phone")))
    }

    fn settings(&self) -> anyhow::Result<Settings> {
        // The dashboard's token, which the core keeps in its data folder.
        let file = self.path("rust-home")?.join("ui-token");
        let token = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
        let settle = self.get("settle-ms").map(str::parse).transpose().context("--settle-ms")?.unwrap_or(250);
        Ok(Settings {
            token: Some(token.trim().to_owned()),
            settle: Duration::from_millis(settle),
            wait_timeout: Duration::from_secs(10),
            // A frame the core never sends is a difference to judge, not a reason to stop.
            report_missing_frames: true,
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

fn replay(args: &Args) -> anyhow::Result<ExitCode> {
    let known = args.known()?;
    let mut target = args.target()?;
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
        let mut runner = Runner::new(&mut target, args.settings()?, vars(&known));
        let mut report = Report { scenario: name.clone(), ..Report::default() };
        // The two sides number generated ids apart once a step is skipped; see `renumber`.
        let (mut recorded_ids, mut answered_ids) = (Renumber::default(), Renumber::default());
        // A step that was not served captures nothing: the steps that needed
        // its ids cannot run either, and are not differences.
        let mut starved = false;
        for exchange in &recording.exchanges {
            let step = &exchange.step;
            let outcome = runner.step(step).with_context(|| format!("{name} / {}", step.name))?;
            let actual = match &outcome {
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
                Outcome::Answered { response, .. } | Outcome::Unrouted { response, .. } => {
                    let all: Vec<&Step> = recording.exchanges.iter().map(|e| &e.step).collect();
                    normalizer.normalize(&rule_route(step, &all), &recording.record_headers, response.clone())
                }
            };
            let mut reasons: Vec<String> = Vec::new();
            let numbered = (recorded_ids.clone(), answered_ids.clone());
            let mut differences = diff(&recorded_ids.apply(&exchange.response), &answered_ids.apply(&actual));
            // Ids met only in an answer that differs (an error on one side, a
            // whole page on the other) would shift the numbers of every later
            // step: such a step numbers nothing for the steps after it.
            if !differences.is_empty() {
                (recorded_ids, answered_ids) = numbered;
            }
            differences.retain(|d| match listed_differences.reason(&name, &step.name, &d.path) {
                Some(reason) => {
                    if !reasons.iter().any(|r| r == reason) {
                        reasons.push(reason.to_owned());
                    }
                    false
                }
                None => true,
            });
            // No route of the core's took it: its router's own answer counts
            // only when it is the daemon's (an unknown path, a refused method).
            if let (Outcome::Unrouted { method, path, .. }, false) = (&outcome, differences.is_empty()) {
                starved |= !step.capture.is_empty();
                unserved_write |= !step.only_reads();
                report.not_served.push(format!("{:<28} {method} {path}", step.name));
                continue;
            }
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
    target.stop();
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
