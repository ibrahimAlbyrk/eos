//! The checks a page design passes before it is offered (05 Q3), as data:
//! the static ones in Rust (the body reads as a page, every action and query
//! it names is Eos's), then each data set it is drawn with in the probe: its
//! sample, the least data its contract allows, and the newest issues whose
//! data fits it.

use std::collections::HashMap;
use std::path::Path;

use eos_core::store::StoredIssue;
use eos_core::surface::{PageProbe, ProbeDoc, ProbeWidth};
use eos_domain::redact::looks_secret;
use eos_runtime::actions::Actions;
use eos_surface::render::{Comfort, IssueFacts, PROBE_JS, RenderInput, frame_document};
use eos_surface::{PageDesign, Problem, minimal_data, validate};
use serde_json::{Value, json};

use crate::ProbeDocs;

/// The widths a design is laid out at: a phone and a wide window.
pub(crate) const PROBE_WIDTHS: [u16; 2] = [360, 1000];
/// How many recent issues a design is also drawn with.
const RECENT_ISSUES: usize = 3;

/// The design, or every problem the static checks found.
pub(crate) fn static_checks(body: &Value, actions: &Actions) -> Result<PageDesign, Vec<Problem>> {
    let design = PageDesign::from_body(body)?;
    let registry = actions.registry();
    let mut problems = Vec::new();
    for (n, id) in design.uses.iter().enumerate() {
        if registry.action(id).is_none() {
            problems.push(Problem::new(format!("uses[{n}]"), format!("`{id}` is no action Eos has")));
        }
    }
    for (n, id) in design.queries.iter().enumerate() {
        if registry.query(id).is_none() {
            problems.push(Problem::new(format!("queries[{n}]"), format!("`{id}` is no query Eos has")));
        }
    }
    if problems.is_empty() { Ok(design) } else { Err(problems) }
}

/// One set of data the design is drawn with, and what to call it in a report.
pub(crate) struct DataSet {
    pub(crate) label: String,
    pub(crate) data: Value,
}

/// The sample, the least data the contract allows, and the newest issues
/// whose data fits the design; an issue that does not fit is left out (an
/// old issue keeps its own design).
pub(crate) fn data_sets(design: &PageDesign, issues: &[StoredIssue]) -> Vec<DataSet> {
    let mut sets = vec![
        DataSet { label: "sample".into(), data: design.sample.clone() },
        DataSet { label: "least data".into(), data: minimal_data(&design.contract.fields) },
    ];
    let contract = design.contract.as_type();
    let fitting = issues.iter().filter_map(|issue| {
        let body: Value = serde_json::from_str(&issue.body_json).ok()?;
        let data = body.get("data")?.clone();
        validate(&contract, &data).is_ok().then_some((issue, data))
    });
    for (issue, data) in fitting.take(RECENT_ISSUES) {
        let label = issue.seq.map_or_else(|| "a trial issue".to_owned(), |seq| format!("issue {seq}"));
        sets.push(DataSet { label, data });
    }
    sets
}

/// What the probe found of one data set.
pub(crate) struct Measured {
    pub(crate) label: String,
    pub(crate) widths: Vec<ProbeWidth>,
}

/// Draws the design with each data set as the dashboard's frame would and
/// measures it at each width.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn measure(
    probe: &dyn PageProbe,
    docs: &ProbeDocs,
    surface_id: &str,
    title: &str,
    design: &PageDesign,
    sets: &[DataSet],
    facts: &IssueFacts,
    shots: &Path,
) -> Result<Vec<Measured>, eos_core::Error> {
    let mut out = Vec::with_capacity(sets.len());
    for (n, set) in sets.iter().enumerate() {
        let url = docs.hold(drawn(surface_id, title, design, &set.data, facts));
        let doc = ProbeDoc { url, script: PROBE_JS.to_owned() };
        let widths = probe.measure(doc, &PROBE_WIDTHS, &shots.join(n.to_string())).await?;
        out.push(Measured { label: set.label.clone(), widths });
    }
    Ok(out)
}

/// The frame document of `data` in `design`, with no image fetched yet.
fn drawn(surface_id: &str, title: &str, design: &PageDesign, data: &Value, facts: &IssueFacts) -> String {
    let images = HashMap::new();
    let live = HashMap::new();
    let no_image = |_: &str| None;
    let input = RenderInput {
        design,
        data,
        issue: facts,
        images: &images,
        image_src: &no_image,
        live: &live,
        is_secret: &looks_secret,
        offset: 0,
        lang: "en",
        title,
        comfort: Comfort { text_scale: 100, more_contrast: false },
    };
    frame_document(&input, surface_id)
}

/// The report kept on the version and shown to the designer and the user.
pub(crate) fn report(measured: &[Measured]) -> (bool, Value) {
    let mut passed = true;
    let sets: Vec<Value> = measured
        .iter()
        .map(|set| {
            let widths: Vec<Value> = set
                .widths
                .iter()
                .map(|w| {
                    passed &= w.findings.is_empty();
                    json!({
                        "width": w.width,
                        "findings": w.findings,
                        "screenshot": w.screenshot.as_ref().map(|p| p.to_string_lossy().into_owned()),
                    })
                })
                .collect();
            json!({ "data": set.label, "widths": widths })
        })
        .collect();
    (passed, json!({ "passed": passed, "probe": sets }))
}
