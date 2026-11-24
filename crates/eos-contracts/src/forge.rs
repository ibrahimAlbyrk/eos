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
