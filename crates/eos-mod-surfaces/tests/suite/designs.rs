//! A design run's designer reads the page it works on and proposes a
//! design: the static checks, then the probe with each data set at 360 and
//! 1000 px, make it the one candidate; a failing check discards it with what
//! failed, and without Eos's window it waits until there is one.

use eos_core::Error;
use eos_core::surface::ProbeFinding;
use eos_runtime::module::Module;
use eos_surface::{IssueKind, Level, MadeBy, Place, VersionStatus};
use serde_json::{Value, json};

use crate::rig::{Rig, issue, surface, version};

pub(crate) fn design(title_max: u32) -> Value {
    json!({
        "template": "<section part=\"lead\"><h2>{lead}</h2></section><ul part=\"list\"><li part=\"story\" each=\"stories\">{item.title}</li></ul>",
        "style": ".lead h2 { font-size: 28px; }",
        "contract": {"type": "object", "fields": {"lead": {"type": "text", "max": title_max},
            "stories": {"type": "list", "min": 1, "max": 5, "of": {"type": "object", "fields": {
                "title": {"type": "text", "max": 80}}}}}},
        "sample": {"lead": "Replays ship", "stories": [{"title": "One"}, {"title": "Two"}]},
    })
}

/// The paper's page with version 1 kept and one issue, and a design run of
/// its routine whose designer is `w-des`, asked for a smaller lead.
pub(crate) async fn paper() -> Rig {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Morning Paper", "rn-d", "design", "w-des");
    let asked = json!({"result": "showOnly", "surface": {"kind": "design", "surfaceId": "sf-paper",
        "baseVersion": 1, "instruction": "Make the lead smaller", "part": "lead", "index": 0}});
    rig.temp.exec(&format!("UPDATE runs SET input = '{asked}' WHERE id = 'rn-d'"));
    rig.run_worker("rt-1", "Morning Paper", "rn-1", "standing", "w-lead");
    let mut page = surface("sf-paper", "rt-1", Level::Page, Place::RoutinePage, 1);
    page.current_version = Some(1);
    let mut v1 = version("sf-paper", 1, VersionStatus::Kept);
    v1.body_json = design(60).to_string();
    let mut old = issue("si-1", "sf-paper");
    old.kind = IssueKind::Page;
    old.version = Some(1);
    old.body_json = json!({"data": {"lead": "Builds got faster", "stories": [{"title": "Cache"}]}}).to_string();
    rig.seed(vec![page], vec![v1], vec![old]).await;
    rig
}

async fn propose(rig: &Rig, body: Value) -> Result<String, Error> {
    rig.module.tools().page_design_propose("w-des", body, "A smaller lead".into()).await
}

pub(crate) async fn row(rig: &Rig, n: i64) -> eos_core::store::StoredSurfaceVersion {
    rig.temp.port().read(move |tx| tx.surface_versions().find("sf-paper", n)).await.expect("reads").expect("a version")
}

pub(crate) async fn candidate(rig: &Rig) -> Option<i64> {
    rig.temp.port().read(|tx| tx.surfaces().find("sf-paper")).await.expect("reads").expect("the page").candidate_version
}

pub(crate) fn phases(rig: &Rig) -> Vec<String> {
    rig.temp
        .announced
        .list()
        .into_iter()
        .filter(|(topic, _)| *topic == "surfaces:design")
        .map(|(_, payload)| {
            serde_json::from_str::<Value>(&payload).expect("json")["phase"].as_str().unwrap_or("").to_owned()
        })
        .collect()
}

#[tokio::test]
async fn the_designer_reads_the_page_what_was_asked_and_its_newest_data() {
    let rig = paper().await;
    let read = rig.module.tools().page_design_read("w-des").await.expect("reads");
    assert_eq!(read["current"]["version"], 1);
    assert_eq!(read["current"]["design"]["sample"]["lead"], "Replays ship");
    assert_eq!(read["instruction"], "Make the lead smaller");
    assert_eq!(read["pointedAt"], json!({"part": "lead", "index": 0}));
    assert_eq!(read["recentIssues"], json!([{"lead": "Builds got faster", "stories": [{"title": "Cache"}]}]));
    let lead = rig.module.tools().page_design_read("w-lead").await;
    assert!(matches!(lead, Err(Error::Validation(_))), "only a design run's designer: {lead:?}");
}

#[tokio::test]
async fn a_design_that_passes_every_check_is_the_one_candidate() {
    let rig = paper().await;
    let line = propose(&rig, design(40)).await.expect("proposed");
    assert!(line.starts_with("version 2 passed every check"), "{line}");
    let v2 = row(&rig, 2).await;
    assert_eq!((v2.status, v2.made_by, v2.base_version), (VersionStatus::Candidate, MadeBy::Designer, Some(1)));
    assert_eq!((v2.run_id.as_deref(), v2.note.as_str()), (Some("rn-d"), "A smaller lead"));
    let checks: Value = serde_json::from_str(&v2.checks_json).expect("json");
    assert_eq!(checks["passed"], true);
    let sets: Vec<&str> =
        checks["probe"].as_array().expect("sets").iter().map(|s| s["data"].as_str().unwrap_or("")).collect();
    assert_eq!(sets, ["sample", "least data", "issue 1"], "the old issue fits, so it is drawn too");
    assert_eq!(checks["probe"][0]["widths"].as_array().map(Vec::len), Some(2));
    let loaded = rig.probe.loaded();
    assert_eq!(loaded.len(), 3);
    assert!(loaded[0].url.starts_with("http://raw.eos.localhost/surfaces/_probe/"));
    assert!(loaded[0].script.contains("__eosProbe"));
    assert_eq!(candidate(&rig).await, Some(2));
    assert_eq!(phases(&rig), ["checking", "candidate"]);

    // A newer design takes the open candidate's place.
    propose(&rig, design(30)).await.expect("proposed again");
    assert_eq!(row(&rig, 2).await.status, VersionStatus::Discarded);
    assert_eq!(row(&rig, 3).await.status, VersionStatus::Candidate);
    assert_eq!(candidate(&rig).await, Some(3));
}

#[tokio::test]
async fn a_design_the_probe_finds_hard_to_read_is_discarded_with_what_failed() {
    let rig = paper().await;
    rig.probe.finding(vec![ProbeFinding {
        check: "readable".into(),
        part: Some("lead".into()),
        detail: "text at 10 px, at least 12 px".into(),
    }]);
    let Err(Error::Validation(said)) = propose(&rig, design(40)).await else { panic!("refused") };
    assert!(said.starts_with("version 2 failed the layout checks"), "{said}");
    assert!(
        said.contains("- readable at 360 px with the sample in part `lead`: text at 10 px, at least 12 px"),
        "{said}"
    );
    assert!(said.contains("Pictures of the page:"), "{said}");
    assert_eq!(row(&rig, 2).await.status, VersionStatus::Discarded);
    assert_eq!(candidate(&rig).await, None);
    assert_eq!(phases(&rig), ["checking", "failed"]);
}

#[tokio::test]
async fn a_design_that_breaks_the_rules_writes_nothing() {
    let rig = paper().await;
    let mut broken = design(40);
    broken["template"] = json!("<section part=\"lead\"><script>x</script>{nowhere}</section>");
    let Err(Error::Validation(said)) = propose(&rig, broken).await else { panic!("refused") };
    assert!(said.contains("template"), "{said}");
    assert!(rig.temp.port().read(|tx| tx.surface_versions().find("sf-paper", 2)).await.expect("reads").is_none());
    assert!(rig.probe.loaded().is_empty());
    let mut unknown = design(40);
    unknown["uses"] = json!(["probe.nowhere"]);
    let Err(Error::Validation(said)) = propose(&rig, unknown).await else { panic!("refused") };
    assert!(said.contains("`probe.nowhere` is no action Eos has"), "{said}");
}

#[tokio::test]
async fn without_a_window_a_design_waits_and_is_checked_once_there_is_one() {
    let rig = paper().await;
    rig.probe.set_available(false);
    let line = propose(&rig, design(40)).await.expect("proposed");
    assert!(line.contains("checked once Eos's window is open"), "{line}");
    assert_eq!(row(&rig, 2).await.status, VersionStatus::Checking);
    assert_eq!(candidate(&rig).await, Some(2));

    rig.probe.set_available(true);
    rig.module.after_ready().await.expect("ready");
    for _ in 0..100 {
        if row(&rig, 2).await.status != VersionStatus::Checking {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(row(&rig, 2).await.status, VersionStatus::Candidate);
    assert_eq!(phases(&rig), ["checking", "waiting", "candidate"]);
}
