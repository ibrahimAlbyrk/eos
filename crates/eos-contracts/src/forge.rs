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
    /// The published package an `official` or `community` way runs,
    /// pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<ForgePackage>,
}

/// A published package pinned to one version and its integrity hash (06
/// G12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ForgePackage {
    /// `npm` or `pypi`.
    pub registry: String,
    pub name: String,
    /// One exact version, never a range.
    pub version: String,
    /// npm's `integrity` (`sha512-…`) or PyPI's `sha256:<hex>`.
    pub integrity: String,
    /// The server's name in the MCP Registry (`io.github.owner/name`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

impl ForgePackage {
    /// How a version's source names it: `npm:pkg@1.2.3#sha512-…`.
    pub fn pin(&self) -> String {
        format!("{}:{}@{}#{}", self.registry, self.name, self.version, self.integrity)
    }
}

/// `1.2.3`, with an optional pre-release or build tail; no range.
fn exact_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    let tail_ok = version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())) && tail_ok
}

fn integrity_ok(registry: &str, integrity: &str) -> bool {
    match registry {
        "npm" => integrity.strip_prefix("sha512-").is_some_and(|b64| {
            b64.len() == 88 && b64.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        }),
        "pypi" => integrity.strip_prefix("sha256:").is_some_and(|hex| {
            hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }),
        _ => false,
    }
}

impl Validate for ForgePackage {
    fn validate(&self, cx: &mut Issues) {
        if !matches!(self.registry.as_str(), "npm" | "pypi") {
            cx.push_at("registry", "npm or pypi");
        }
        let name_ok = !self.name.is_empty()
            && self.name.len() <= 214
            && self.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-'))
            && self.name.split('/').all(|part| !matches!(part, "" | "." | ".."));
        if !name_ok {
            cx.push_at("name", "the package's name as its registry spells it");
        }
        if !exact_version(&self.version) {
            cx.push_at("version", "one exact version, such as 1.2.3: no range");
        }
        if !integrity_ok(&self.registry, &self.integrity) {
            cx.push_at("integrity", "npm's sha512-<base64> integrity, or PyPI's sha256:<hex>");
        }
    }
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
        let published = matches!(self.source.as_str(), "official" | "community");
        match &self.package {
            Some(package) => cx.at("package", |cx| package.validate(cx)),
            None if published => cx.push_at("package", "an official or community way names its package, pinned"),
            None => {}
        }
        if self.package.is_some() && !published {
            cx.push_at("package", "only an official or community way runs a published package");
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
    /// The published package it runs, when it is code from elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ProposedSource>,
    /// The installed version it would replace: only a repair of that
    /// capability proposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<ProposedUpdate>,
}

/// The installed version a proposal replaces, and what the new one may do
/// that it could not, in plain words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProposedUpdate {
    pub version: String,
    pub widens: Vec<String>,
}

/// The published package a proposed capability runs, as Eos checked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProposedSource {
    pub package: ForgePackage,
    /// The researcher found no official server: someone else published it.
    pub community: bool,
    /// Every package it installed, `name@version`.
    pub dependencies: Vec<String>,
    /// The packages that declare install scripts, which were kept off.
    pub install_scripts: Vec<String>,
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
            package: None,
        };
        assert_eq!(issues(&ForgeResearch { options: vec![option.clone()] }), 0);
        assert_eq!(issues(&ForgeResearch { options: vec![] }), 1);
        assert_eq!(issues(&ForgeResearch { options: vec![option.clone(); 4] }), 1);
        let odd = ForgeOption { works: "phone".into(), source: "maybe".into(), ..option };
        assert_eq!(issues(&ForgeResearch { options: vec![odd] }), 2);
    }

    #[test]
    fn a_published_way_names_its_package_pinned_to_one_version_and_its_hash() {
        let package = ForgePackage {
            registry: "npm".into(),
            name: "@acme/sms-mcp".into(),
            version: "1.4.2".into(),
            integrity: format!("sha512-{}==", "A".repeat(86)),
            server: Some("io.github.acme/sms".into()),
        };
        assert_eq!(issues(&package), 0);
        assert_eq!(package.pin(), format!("npm:@acme/sms-mcp@1.4.2#{}", package.integrity));
        for range in ["^1.4.2", "1.4", "1.x.0", "latest", ">=1.0.0", "1.4.2 || 2.0.0"] {
            assert_eq!(issues(&ForgePackage { version: range.into(), ..package.clone() }), 1, "{range}");
        }
        assert_eq!(issues(&ForgePackage { integrity: "sha1-abc".into(), ..package.clone() }), 1);
        assert_eq!(issues(&ForgePackage { name: "../x".into(), ..package.clone() }), 1);
        let pypi = ForgePackage {
            registry: "pypi".into(),
            name: "acme-sms".into(),
            integrity: format!("sha256:{}", "0f".repeat(32)),
            server: None,
            ..package.clone()
        };
        assert_eq!(issues(&pypi), 0);

        let way = |source: &str, package: Option<ForgePackage>| ForgeOption {
            key: "acme".into(),
            title: "Acme's server".into(),
            how: "Acme's own MCP server.".into(),
            cost: "free".into(),
            setup: "An Acme account".into(),
            works: "any_mac".into(),
            reach: vec!["api.acme.com".into()],
            source: source.into(),
            package,
        };
        assert_eq!(issues(&way("official", Some(package.clone()))), 0);
        assert_eq!(issues(&way("community", None)), 1, "a published way is pinned");
        assert_eq!(issues(&way("build", Some(package))), 1, "a way the Forge builds runs no published package");
    }
}
