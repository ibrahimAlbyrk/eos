use eos_domain::routine::blueprint::{Context, Readable, Severity, read, validate};
use serde_json::json;

use crate::rig::{Rig, definitions};

#[test]
fn the_forges_blueprint_passes_the_routines_rules_with_each_session_from_its_definition() {
    let blueprint = eos_mod_forge::blueprint(&definitions()).expect("made");
    let Ok(Readable::Current(typed)) = read(&blueprint) else { panic!("a blueprint of this app") };
    let context = Context { routine: "rt-forge", chains: &[], known_zone: &|_| true, data_dir: None };
    let errors: Vec<_> = validate(&typed, &context).into_iter().filter(|i| i.severity == Severity::Error).collect();
    assert!(errors.is_empty(), "{errors:?}");
    let builder = &blueprint["who"]["agents"][2];
    assert_eq!((builder["key"].as_str(), builder["definition"].as_str()), (Some("builder"), Some("forge-builder")));
    assert!(builder["brief"].as_str().is_some_and(|brief| brief.contains("forge_report")), "{builder}");
    assert_eq!(builder["tools"]["allow"][0], json!("Read"));
    let systems: Vec<&str> = blueprint["project"]["milestones"]
        .as_array()
        .expect("milestones")
        .iter()
        .filter_map(|milestone| milestone["system"].as_str())
        .collect();
    assert_eq!(systems, ["forge.test", "forge.propose"]);
    assert_eq!(blueprint["makes"]["kind"], "nothing", "no milestone is a result sent anywhere");
    assert_eq!(blueprint["limits"]["parallel"], 3);
}

#[test]
fn a_missing_definition_is_an_error_not_a_session_without_a_brief() {
    let mut some = definitions();
    some.retain(|definition| definition.name != "forge-reviewer");
    assert!(eos_mod_forge::blueprint(&some).is_err());
}

#[tokio::test]
async fn the_routine_is_kept_once_the_app_is_ready() {
    let rig = Rig::ready().await;
    let kept = rig.builtins.0.lock().expect("kept").clone();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].0, "forge");
}
