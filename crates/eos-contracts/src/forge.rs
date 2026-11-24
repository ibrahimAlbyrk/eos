//! What `POST /api/forge` takes and answers, and the reports the Forge's
//! sessions hand in with `forge_report` (06 G9): the researcher's options,
//! the builder's package, the reviewer's verdict.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::{Issues, Validate};

/// The longest need the Forge takes.
pub const FORGE_NEED_MAX: usize = 2000;
/// The researcher offers one to three ways.
pub const FORGE_OPTIONS_MAX: usize = 3;

/// `POST /api/forge`: build what `need` describes. `routineId` is the
/// routine that waits for it, `capabilityId` a capability to repair or
/// update, `fromSurface` an App to promote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStart {
    pub need: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_surface: Option<String>,
}

impl Validate for ForgeStart {
    fn validate(&self, cx: &mut Issues) {
        cx.at("need", |cx| {
            cx.str_min(self.need.trim(), 1);
            cx.str_max(&self.need, FORGE_NEED_MAX);
        });
    }
}

/// The Forge run `POST /api/forge` started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStarted {
    pub run_id: String,
}

impl Validate for ForgeStarted {}

/// `forge_report` stage `research`: the ways to do it, best first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ForgeResearch {
    pub options: Vec<ForgeOption>,
}

impl Validate for ForgeResearch {
    fn validate(&self, cx: &mut Issues) {
        cx.at("options", |cx| {
            cx.arr_min(self.options.len(), 1);
            cx.arr_max(self.options.len(), FORGE_OPTIONS_MAX);
            for (index, option) in self.options.iter().enumerate() {
                cx.idx(index, |cx| option.validate(cx));
            }
        });
    }
}

/// One way the researcher found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForgeOption {
    pub key: String,
    pub title: String,
    /// How it works, in a few plain sentences.
    pub how: String,
    /// What it costs the user: "free", "per message plus fees".
    pub cost: String,
    /// What the user sets up first.
    pub setup: String,
    /// `this_mac` or `any_mac`.
    pub works: String,
    /// The hosts and apps it reaches.
    pub reach: Vec<String>,
    /// `builtin`, `official`, `community` or `build`.
    pub source: String,
}

impl Validate for ForgeOption {
    fn validate(&self, cx: &mut Issues) {
        for (key, value) in [("key", &self.key), ("title", &self.title), ("how", &self.how)] {
            cx.at(key, |cx| cx.str_min(value, 1));
        }
        if !matches!(self.works.as_str(), "this_mac" | "any_mac") {
            cx.push_at("works", "this_mac or any_mac");
        }
        if !matches!(self.source.as_str(), "builtin" | "official" | "community" | "build") {
            cx.push_at("source", "builtin, official, community or build");
        }
    }
}

/// `forge_report` stage `build`: the package the builder made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForgeBuild {
    /// The package's folder, relative to the build folder.
    pub package: String,
    pub capability_id: String,
    pub version: String,
    pub summary: String,
    /// The key of the researcher's way it builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option: Option<String>,
}

impl Validate for ForgeBuild {
    fn validate(&self, cx: &mut Issues) {
        cx.at("package", |cx| {
            let path = std::path::Path::new(&self.package);
            let inside = path.components().all(|part| matches!(part, std::path::Component::Normal(_)));
            if self.package.is_empty() || !inside {
                cx.push("a folder inside the build folder, without `..`");
            }
        });
        for (key, value) in [("capabilityId", &self.capability_id), ("version", &self.version)] {
            cx.at(key, |cx| cx.str_min(value, 1));
        }
    }
}

/// `forge_report` stage `review`: the reviewer's verdict on the package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ForgeReview {
    /// `pass` or `fail`.
    pub verdict: String,
    #[serde(default)]
    pub findings: Vec<ForgeFinding>,
}

impl Validate for ForgeReview {
    fn validate(&self, cx: &mut Issues) {
        if !matches!(self.verdict.as_str(), "pass" | "fail") {
            cx.push_at("verdict", "pass or fail");
        }
        cx.at("findings", |cx| {
            for (index, finding) in self.findings.iter().enumerate() {
                cx.idx(index, |cx| finding.validate(cx));
            }
        });
    }
}

/// What the reviewer found, where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ForgeFinding {
    /// `high`, `medium` or `low`.
    pub severity: String,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    pub text: String,
}

impl Validate for ForgeFinding {
    fn validate(&self, cx: &mut Issues) {
        if !matches!(self.severity.as_str(), "high" | "medium" | "low") {
            cx.push_at("severity", "high, medium or low");
        }
        cx.at("text", |cx| cx.str_min(&self.text, 1));
    }
}

/// The capability Eos proposes once a Forge run's package passed its tests
/// and review (`GET /api/forge/proposals/:runId`, and the payload of its
/// `capability_install` item): what it does, reaches and costs, and how it
/// was tested. Settings and secrets appear by name and label only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityProposal {
    pub run_id: String,
    pub capability_id: String,
    pub name: String,
    pub version: String,
    pub summary: String,
    /// `skill`, `script`, `mcp` or `plugin`.
    pub form: String,
    /// `this_mac` or `any_mac`.
    pub works: String,
    pub actions: Vec<ProposedAction>,
    pub reach: ProposedReach,
    pub secrets: Vec<ProposedField>,
    pub settings: Vec<ProposedField>,
    /// What the user said it costs, from the way they chose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<String>,
    /// The package's hash: what was tested and reviewed is what installs.
    pub hash: String,
    pub size_bytes: u64,
    pub tests: ProposedTests,
    pub review: ForgeReview,
    /// The live test, when the package declares one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_test: Option<LiveTest>,
    /// The routines that wait for it.
    pub routines: Vec<ProposedRoutine>,
    /// What Eos's checks cannot promise, in plain words.
    pub limits: Vec<String>,
}

impl Validate for CapabilityProposal {}

/// One action of a proposed capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposedAction {
    pub name: String,
    pub summary: String,
    /// `read`, `write_local`, `tell_user`, `speak` or `irreversible`.
    pub class: String,
}

/// What a proposed capability reaches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposedReach {
    pub hosts: Vec<String>,
    /// The apps it sends Apple Events to, by bundle id.
    pub apps: Vec<String>,
    pub files: Vec<String>,
}

/// A secret or setting the user gives on install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposedField {
    pub name: String,
    pub label: String,
}

/// Eos's own tests of the package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposedTests {
    pub passed: bool,
    /// Reads of system preference files the audit let pass.
    pub tolerated: usize,
}

/// The one real call the user starts before installing, and their word on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveTest {
    pub action: String,
    /// `not_run`, `sent`, `failed`, `alerted` or `not_alerted`.
    pub state: String,
}

/// A routine that waits for a proposed capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposedRoutine {
    pub id: String,
    pub name: String,
}

/// `GET /api/forge/proposals/:runId`: the proposal and where its item stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProposalState {
    pub item_id: String,
    /// The item's state: `open`, `answered`, …
    pub state: String,
    pub proposal: CapabilityProposal,
}

impl Validate for ProposalState {}

/// `POST /api/forge/proposals/:runId/answer`, this computer's dashboard only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposalAnswer {
    pub choice: ProposalChoice,
}

impl Validate for ProposalAnswer {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProposalChoice {
    Install,
    Decline,
    /// The live test reached the user.
    Alerted,
    /// It did not: the user may decline, or ask for another way.
    NotAlerted,
    /// Decline, and start a Forge run for another way than this one.
    OtherWay,
}

/// `POST /api/forge/proposals/:runId/live-test`: the settings the live
/// call needs, by name. They are kept for the install, never stored before.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct LiveTestStart {
    #[serde(default)]
    pub settings: std::collections::BTreeMap<String, String>,
}

impl Validate for LiveTestStart {}

#[cfg(test)]
mod tests {
    use super::*;

    fn issues(value: &impl Validate) -> usize {
        let mut cx = Issues::default();
        value.validate(&mut cx);
        cx.into_vec().len()
    }

    #[test]
    fn a_package_stays_inside_the_build_folder() {
        let build = |package: &str| ForgeBuild {
            package: package.into(),
            capability_id: "sms-messages".into(),
            version: "1.0.0".into(),
            summary: "Texts you.".into(),
            option: None,
        };
        assert_eq!(issues(&build("package")), 0);
        for outside in ["", "../x", "/tmp/x", "a/../../x", "."] {
            assert_eq!(issues(&build(outside)), 1, "{outside}");
        }
    }

    #[test]
    fn research_offers_one_to_three_ways_of_known_kinds() {
        let option = ForgeOption {
            key: "messages".into(),
            title: "Messages on this Mac".into(),
            how: "Your iPhone relays it.".into(),
            cost: "free".into(),
            setup: "Text Message Forwarding".into(),
            works: "this_mac".into(),
            reach: vec!["com.apple.MobileSMS".into()],
            source: "build".into(),
        };
        assert_eq!(issues(&ForgeResearch { options: vec![option.clone()] }), 0);
        assert_eq!(issues(&ForgeResearch { options: vec![] }), 1);
        assert_eq!(issues(&ForgeResearch { options: vec![option.clone(); 4] }), 1);
        let odd = ForgeOption { works: "phone".into(), source: "maybe".into(), ..option };
        assert_eq!(issues(&ForgeResearch { options: vec![odd] }), 2);
    }
}
