//! `forge.propose` (06 G9 station 6): once the reviewer passed the package,
//! Eos proposes it to the user as one `capability_install` item, with what
//! it does, reaches and costs, and how it was tested. The files proposed
//! are the ones reviewed and tested: a package that changed after its
//! review is not proposed, and one that changed after its tests is tested
//! again. The version is recorded as `proposed`; nothing is installed here.

use eos_contracts::{
    CapabilityProposal, ForgeBuild, ForgeOption, ForgeReview, LiveTest, ProposedAction, ProposedField, ProposedReach,
    ProposedRoutine, ProposedSource, ProposedTests, ProposedUpdate,
};
use eos_core::Error;
use eos_core::forge::ForgeStage;
use eos_core::routine::{StepResult, SubmittedResult, SystemStepCall};
use eos_core::store::StoredCapabilityVersion;
use eos_domain::capability::manifest::Manifest;
use eos_domain::inbox::ItemKind;
use eos_inbox::{NewItem, Opening, open_in};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::package::{Built, chosen, newest, read};
use crate::request::report_event;
use crate::steps::ForgeSteps;
use crate::tested::{TEST_EVENT, Tested, test};

/// The run event that names the proposal's item.
pub const PROPOSAL_EVENT: &str = "forge_proposal";
/// The module that acts on a proposal's answer.
pub const PRODUCER: &str = "forge";
/// The status of a version the user has not answered yet.
pub(crate) const PROPOSED: &str = "proposed";

/// What a proposal's event keeps.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Proposed {
    pub(crate) item_id: String,
}

/// The subject a run's proposal item has.
pub(crate) fn subject(run_id: &str) -> String {
    format!("forge:{run_id}")
}

/// What a version's row names as its source: the pinned package it runs,
/// or the Forge run that built it.
pub(crate) fn source_of(proposal: &CapabilityProposal, run_id: &str) -> String {
    proposal.source.as_ref().map_or_else(|| run_id.to_owned(), |source| source.package.pin())
}

/// A passed review, with the hash of the files the reviewer read.
#[derive(Deserialize)]
struct Reviewed {
    #[serde(flatten)]
    review: ForgeReview,
    #[serde(default)]
    hash: Option<String>,
}

pub(crate) async fn step(steps: &ForgeSteps, call: &SystemStepCall) -> Result<StepResult, Error> {
    let run_id = call.run_id.as_str();
    let store = steps.store.as_ref();
    let failed = |reason: &str| Ok(StepResult::Failed { reason: reason.to_owned() });
    let Some(build) = newest::<ForgeBuild>(store, run_id, &report_event(ForgeStage::Build)).await? else {
        return failed("The builder reported no package.");
    };
    let built = match read(steps, run_id, &build).await? {
        Ok(built) => built,
        Err(why) => return failed(&format!("The package cannot be proposed: {why}.")),
    };
    let reviewed = newest::<Reviewed>(store, run_id, &report_event(ForgeStage::Review)).await?;
    let Some(reviewed) = reviewed.filter(|reviewed| reviewed.review.verdict == "pass") else {
        return failed("The reviewer has not passed the package.");
    };
    if reviewed.hash.as_deref() != Some(built.hash.as_str()) {
        return failed("The package changed after its review, so it is not proposed.");
    }
    let way = chosen(store, run_id, &build).await?;
    let pin = way.as_ref().and_then(|way| way.package.as_ref());
    let tested = match newest::<Tested>(store, run_id, TEST_EVENT).await? {
        Some(tested) if tested.hash == built.hash => tested,
        _ => test(steps, run_id, &built, pin).await?,
    };
    if !tested.passed {
        return failed(&format!("Eos's tests failed: {}.", tested.failures.join("; ")));
    }
    let waiting = call.input.options.get("routine").and_then(Value::as_str).map(str::to_owned);
    let proposal = proposal_of(run_id, &built, &tested, reviewed.review, way);
    match open(steps, call, proposal, waiting, built.manifest.clone()).await? {
        Ok(item_id) => Ok(StepResult::Done(SubmittedResult {
            kind: "nothing".into(),
            headline: format!("{} {} waits for your answer in Needs you", built.manifest.name, built.manifest.version),
            body: json!({"itemId": item_id}),
            files: Vec::new(),
        })),
        Err(why) => failed(&why),
    }
}

fn proposal_of(
    run_id: &str,
    built: &Built,
    tested: &Tested,
    review: ForgeReview,
    way: Option<ForgeOption>,
) -> CapabilityProposal {
    let manifest = &built.manifest;
    let word = |value: Value| value.as_str().unwrap_or_default().to_owned();
    let live_test = manifest
        .tests
        .as_ref()
        .and_then(|tests| tests.live.clone())
        .map(|action| LiveTest { action, state: "not_run".into() });
    let mut limits = vec![
        "Eos's audit cannot see a helper program whose name the system's log leaves out; the reviewer read the code for that."
            .to_owned(),
        "The system names no host when it stops a connection around Eos's proxy, so any such attempt failed the tests."
            .to_owned(),
    ];
    if tested.tolerated > 0 {
        limits.push(format!("{} reads of system preference files were let pass.", tested.tolerated));
    }
    if live_test.is_some() {
        limits.push("The live test is one real call, made only when you start it.".to_owned());
    }
    let (cost, published) = way.map_or((None, None), |way| (Some(way.cost), way.package.map(|p| (p, way.source))));
    let source = published.map(|(package, source)| ProposedSource {
        package,
        community: source == "community",
        dependencies: tested.dependencies.clone(),
        install_scripts: tested.install_scripts.clone(),
    });
    if let Some(source) = &source {
        limits.push(format!(
            "Who published {} is what the MCP Registry says; Eos checked its version and hash, not its publisher.",
            source.package.name
        ));
        if !source.install_scripts.is_empty() {
            limits.push(format!(
                "{} of its packages declare install scripts. They were to stay off while it was built in the sandbox; Eos cannot prove that afterwards.",
                source.install_scripts.len()
            ));
        }
    }
    CapabilityProposal {
        run_id: run_id.to_owned(),
        capability_id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        summary: manifest.summary.clone(),
        form: word(json!(manifest.form)),
        works: word(json!(manifest.works)),
        actions: manifest
            .actions
            .iter()
            .map(|action| ProposedAction {
                name: action.name.clone(),
                summary: action.summary.clone(),
                class: word(json!(action.class)),
            })
            .collect(),
        reach: ProposedReach {
            hosts: manifest.reach.hosts.clone(),
            apps: manifest.reach.apple_events.clone(),
            files: manifest.reach.files_read.clone(),
        },
        secrets: manifest
            .secrets
            .iter()
            .map(|s| ProposedField { name: s.name.clone(), label: s.label.clone() })
            .collect(),
        settings: manifest
            .settings
            .iter()
            .map(|s| ProposedField { name: s.name.clone(), label: s.label.clone() })
            .collect(),
        cost,
        hash: built.hash.clone(),
        size_bytes: built.size,
        tests: ProposedTests { passed: tested.passed, tolerated: tested.tolerated },
        review,
        live_test,
        routines: Vec::new(),
        limits,
        source,
        replaces: None,
    }
}

/// What `new` may do that the installed `old` could not: each host, app,
/// file, secret and action it adds, and each action that counts for more.
fn widens(old: &Manifest, new: &Manifest) -> Vec<String> {
    let mut lines = Vec::new();
    let added = |was: &[String], now: &[String]| -> Vec<String> {
        now.iter().filter(|item| !was.contains(item)).cloned().collect()
    };
    for (what, was, now) in [
        ("Reaches", &old.reach.hosts, &new.reach.hosts),
        ("Sends Apple Events to", &old.reach.apple_events, &new.reach.apple_events),
        ("Reads", &old.reach.files_read, &new.reach.files_read),
    ] {
        lines.extend(added(was, now).into_iter().map(|item| format!("{what} {item}")));
    }
    let names = |m: &Manifest| m.secrets.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
    for name in added(&names(old), &names(new)) {
        let label = new.secrets.iter().find(|s| s.name == name).map_or(name.clone(), |s| s.label.clone());
        lines.push(format!("Needs the secret {label}"));
    }
    for action in &new.actions {
        match old.actions.iter().find(|was| was.name == action.name) {
            None => {
                lines.push(format!("Can {} ({})", action.summary, json!(action.class).as_str().unwrap_or_default()))
            }
            Some(was) if was.class != action.class => lines.push(format!(
                "{} counts as {} where it counted as {}",
                action.summary,
                json!(action.class).as_str().unwrap_or_default(),
                json!(was.class).as_str().unwrap_or_default()
            )),
            Some(_) => {}
        }
    }
    lines
}

/// Whether the package may take its id: never a built-in's, and an
/// installed capability's only in a repair of that capability. The version
/// it replaces, with what the new one adds; or why it may not.
fn replaced(
    tx: &dyn eos_core::store::Tx,
    id: &str,
    repair: Option<&str>,
    new: &Manifest,
) -> Result<Result<Option<ProposedUpdate>, String>, Error> {
    let Some(install) = tx.capability_installs().find(id)? else { return Ok(Ok(None)) };
    if install.origin == "builtin" {
        return Ok(Err(format!("It names {id}, a capability built into Eos: a package takes an id of its own.")));
    }
    if repair != Some(id) {
        return Ok(Err(format!("It names {id}, a capability you have already: only a repair of {id} may replace it.")));
    }
    let Some(version) = install.active_version else { return Ok(Ok(None)) };
    let old =
        tx.capability_versions().find(id, &version)?.and_then(|row| serde_json::from_str(&row.manifest_json).ok());
    let widens = old.map_or_else(
        || vec!["Eos could not read what the installed version may do.".to_owned()],
        |old| widens(&old, new),
    );
    Ok(Ok(Some(ProposedUpdate { version, widens })))
}

/// Records the version as proposed and opens its item, in one job; the
/// item's id, or why the version cannot be proposed.
async fn open(
    steps: &ForgeSteps,
    call: &SystemStepCall,
    mut proposal: CapabilityProposal,
    waiting: Option<String>,
    manifest: Manifest,
) -> Result<Result<String, String>, Error> {
    let manifest_json = serde_json::to_string(&manifest).map_err(Error::storage)?;
    let repair = call.input.options.get("capability").and_then(Value::as_str).map(str::to_owned);
    let (ids, zone, control) = (steps.ids.clone(), steps.zone.clone(), steps.control()?);
    let (run_id, routine_id, now) = (call.run_id.clone(), call.routine_id.clone(), steps.clock.now_ms());
    steps
        .store
        .write(move |tx, out| {
            if let Some(id) = waiting.as_deref()
                && let Some(routine) = tx.routines().find(id)?
            {
                proposal.routines.push(ProposedRoutine { id: routine.id, name: routine.name });
            }
            let (id, version) = (proposal.capability_id.clone(), proposal.version.clone());
            match replaced(tx, &id, repair.as_deref(), &manifest)? {
                Ok(replaces) => proposal.replaces = replaces,
                Err(why) => return Ok(Err(why)),
            }
            match tx.capability_versions().find(&id, &version)? {
                None => tx.capability_versions().insert(&StoredCapabilityVersion {
                    capability_id: id.clone(),
                    version: version.clone(),
                    status: PROPOSED.to_owned(),
                    hash: proposal.hash.clone(),
                    manifest_json,
                    source: crate::proposal::source_of(&proposal, &run_id),
                    tests_json: Some(json!(proposal.tests).to_string()),
                    review_json: Some(json!(proposal.review).to_string()),
                    created_at: now,
                    activated_at: None,
                    retired_at: None,
                })?,
                Some(known) if known.hash != proposal.hash => {
                    return Ok(Err(format!(
                        "Version {version} was made before with other files: the package needs a new version."
                    )));
                }
                Some(known) if known.status == "installed" => {
                    return Ok(Err(format!("Version {version} is installed already.")));
                }
                Some(_) => drop(tx.capability_versions().set_status(&id, &version, PROPOSED, None, None)?),
            }
            let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
            let item = open_in(
                tx,
                out,
                &at,
                NewItem {
                    kind: ItemKind::CapabilityInstall,
                    producer: PRODUCER.to_owned(),
                    routine_id: Some(routine_id),
                    run_id: Some(run_id.clone()),
                    subject_key: Some(subject(&run_id)),
                    title: format!("Install {}?", proposal.name),
                    summary: proposal.summary.clone(),
                    payload: json!(proposal),
                    by_hand: true,
                },
            )?;
            let data = json!(Proposed { item_id: item.id.clone() }).to_string();
            tx.runs().append_event(&run_id, now, PROPOSAL_EVENT, Some(&data))?;
            tracing::info!(run_id, item_id = %item.id, "a capability was proposed");
            Ok(Ok(item.id))
        })
        .await
}
