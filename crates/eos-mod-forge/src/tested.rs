//! `forge.test` (06 G9 station 4): Eos, not an agent, tests the package the
//! builder reported. Its manifest passes the check, its offline tests pass
//! under the sandbox's audit with fake secrets planted, and the hash of the
//! files tested is kept. The live test is not run here: it reaches the user
//! for real, so only the user starts it, from the proposal.

use eos_contracts::ForgeBuild;
use eos_core::Error;
use eos_core::forge::ForgeStage;
use eos_core::routine::{StepResult, SubmittedResult};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::package::{Built, newest, read};
use crate::request::report_event;
use crate::steps::ForgeSteps;

/// The run event Eos's tests are kept as.
pub const TEST_EVENT: &str = "forge_test";

/// What Eos's tests of a package came to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tested {
    pub(crate) hash: String,
    pub(crate) passed: bool,
    /// Eos's own words, never what the code printed.
    pub(crate) failures: Vec<String>,
    pub(crate) tolerated: usize,
}

pub(crate) async fn step(steps: &ForgeSteps, run_id: &str) -> Result<StepResult, Error> {
    let Some(build) = newest::<ForgeBuild>(steps.store.as_ref(), run_id, &report_event(ForgeStage::Build)).await?
    else {
        return Ok(StepResult::Failed { reason: "The builder reported no package to test.".into() });
    };
    let built = match read(steps, run_id, &build).await? {
        Ok(built) => built,
        Err(why) => return Ok(StepResult::Failed { reason: format!("Eos could not test the package: {why}.") }),
    };
    let tested = test(steps, run_id, &built).await?;
    if !tested.passed {
        return Ok(StepResult::Failed { reason: format!("Eos's tests failed: {}.", tested.failures.join("; ")) });
    }
    let headline = format!("Eos's tests of {} {} passed", built.manifest.name, built.manifest.version);
    Ok(StepResult::Done(SubmittedResult {
        kind: "nothing".into(),
        headline,
        body: json!({"hash": tested.hash, "tolerated": tested.tolerated}),
        files: Vec::new(),
    }))
}

/// Runs Eos's tests of `built` and keeps what they came to as the run's
/// [`TEST_EVENT`].
pub(crate) async fn test(steps: &ForgeSteps, run_id: &str, built: &Built) -> Result<Tested, Error> {
    let outcome = steps.trial.offline(&built.dir, &built.manifest, &steps.tests_folder()).await;
    let tested = Tested {
        hash: built.hash.clone(),
        passed: outcome.passed,
        failures: outcome.failures,
        tolerated: outcome.tolerated,
    };
    let (id, now, data) =
        (run_id.to_owned(), steps.clock.now_ms(), serde_json::to_string(&tested).map_err(Error::storage)?);
    steps.store.write(move |tx, _| tx.runs().append_event(&id, now, TEST_EVENT, Some(&data))).await?;
    tracing::info!(run_id, passed = tested.passed, failures = tested.failures.len(), "a Forge package was tested");
    Ok(tested)
}
