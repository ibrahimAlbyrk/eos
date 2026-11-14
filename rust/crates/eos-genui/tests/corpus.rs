//! The differential harness: the Rust port against what the TypeScript
//! implementation returned, vector by vector (`rust/fixtures/genui`, frozen from the TypeScript, see `rust/fixtures/README.md`).

mod support;

use eos_genui::catalog::{
    ACTION_KINDS, AttrDef, COLLECTION_ATTRS, COMPONENT_GROUPS, COMPONENTS, CollectionUse, ENTITY_TYPES, GENUI_ICONS,
    GENUI_LIMITS, GENUI_TONES, GLOBAL_ATTRS, PRESENT_KEYS,
};
use eos_genui::expr::{EXPR_FUNCTIONS, EXPR_MAX_LENGTH, EXPR_ROOTS};
use eos_genui::markup::RAW_TEXT_TAGS;
use eos_genui::{Object, Value, catalog_prompt};
use support::{Corpus, fixtures, read_json, run_file};

const NOT_VECTORS: &[&str] = &["docs.json", "bases.json", "scopes.json", "catalog.json", "manifest.json"];

#[test]
fn every_vector_matches_the_typescript_result() {
    let corpus = Corpus::load();
    let manifest = read_json(&fixtures().join("manifest.json"));
    let mut files: Vec<String> = std::fs::read_dir(fixtures())
        .expect("rust/fixtures/genui")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".json") && !NOT_VECTORS.contains(&name.as_str()))
        .collect();
    files.sort();

    let outcomes: Vec<_> = files.iter().map(|name| run_file(&corpus, name)).collect();

    let mut total = 0;
    let mut failed = 0;
    let mut report = String::new();
    for (name, outcome) in files.iter().zip(outcomes) {
        let family = name.trim_end_matches(".json");
        let expected = manifest.get("vectors").and_then(|v| v.get(family)).and_then(Value::as_f64).unwrap_or(-1.0);
        assert_eq!(
            outcome.checked as f64, expected,
            "{name}: the manifest counts {expected} vectors, the harness ran {}",
            outcome.checked
        );
        total += outcome.checked;
        failed += outcome.mismatches.len();
        if !outcome.mismatches.is_empty() {
            report.push_str(&format!("\n{name}: {} of {} differ\n", outcome.mismatches.len(), outcome.checked));
            for m in outcome.mismatches.iter().take(8) {
                report.push_str(&format!("  {m}\n"));
            }
        }
    }
    assert_eq!(
        Some(total as f64),
        manifest.get("total").and_then(Value::as_f64),
        "the corpus and its manifest disagree on the number of vectors"
    );
    println!("{total} vectors, {} match", total - failed);
    assert!(failed == 0, "{failed} of {total} vectors differ from the TypeScript result:{report}");
}

#[test]
fn catalog_prompt_is_the_typescript_text_byte_for_byte() {
    let expected = std::fs::read(fixtures().join("catalog-prompt.txt")).expect("catalog-prompt.txt");
    let got = catalog_prompt();
    if got.as_bytes() != expected {
        let expected = String::from_utf8_lossy(&expected);
        let line = got
            .lines()
            .zip(expected.lines())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| got.lines().count().min(expected.lines().count()));
        panic!(
            "catalog_prompt() differs from the TypeScript at line {}:\n  rust:       {}\n  typescript: {}",
            line + 1,
            got.lines().nth(line).unwrap_or("<end>"),
            expected.lines().nth(line).unwrap_or("<end>")
        );
    }
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|s| Value::String((*s).to_owned())).collect())
}

fn attr_def(a: &AttrDef) -> Value {
    let mut o = Object::new();
    o.insert("kind", Value::String(a.kind.as_str().to_owned()));
    if a.required {
        o.insert("required", Value::Bool(true));
    }
    if a.kind == eos_genui::catalog::AttrKind::Enum {
        o.insert("values", strings(a.values));
    }
    if let Some(min) = a.min {
        o.insert("min", Value::Number(min));
    }
    if let Some(max) = a.max {
        o.insert("max", Value::Number(max));
    }
    if let Some(doc) = a.doc {
        o.insert("doc", Value::String(doc.to_owned()));
    }
    if a.brief {
        o.insert("brief", Value::Bool(true));
    }
    if a.item {
        o.insert("item", Value::Bool(true));
    }
    Value::Object(o)
}

fn attr_list(attrs: &[(&str, AttrDef)]) -> Value {
    Value::Array(
        attrs.iter().map(|(name, a)| Value::Array(vec![Value::String((*name).to_owned()), attr_def(a)])).collect(),
    )
}

fn entries<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().collect())
}

// The tables themselves, not only their effects: a component, attribute, limit or
// doc string that drifts is named here.
#[test]
fn catalog_tables_equal_the_typescript_tables() {
    let expected = read_json(&fixtures().join("catalog.json"));
    let n = |v: usize| Value::Number(v as f64);
    let l = GENUI_LIMITS;
    let limits = entries([
        ("titleChars", n(l.title_chars)),
        ("summaryChars", n(l.summary_chars)),
        ("uiBytes", n(l.ui_bytes)),
        ("dataBytes", n(l.data_bytes)),
        ("depth", n(l.depth)),
        ("carouselMin", n(l.carousel_min)),
        ("carouselMax", n(l.carousel_max)),
        ("maps", n(l.maps)),
        ("images", n(l.images)),
        ("primaryActions", n(l.primary_actions)),
        ("actionLabelChars", n(l.action_label_chars)),
        ("stateBytes", n(l.state_bytes)),
        ("appHtmlBytes", n(l.app_html_bytes)),
        ("appHeightMin", n(l.app_height_min)),
        ("appHeightMax", n(l.app_height_max)),
        ("tabsMin", n(l.tabs_min)),
        ("tabsMax", n(l.tabs_max)),
    ]);
    let components: Vec<Value> = COMPONENTS
        .iter()
        .map(|c| {
            entries([
                ("name", Value::String(c.name.to_owned())),
                ("group", Value::String(c.group.as_str().to_owned())),
                ("doc", Value::String(c.doc.to_owned())),
                ("attrs", attr_list(c.attrs)),
                ("children", Value::String(c.children.as_str().to_owned())),
                (
                    "collection",
                    match c.collection {
                        None => Value::Null,
                        Some(CollectionUse::Required) => Value::String("required".to_owned()),
                        Some(CollectionUse::Optional) => Value::String("optional".to_owned()),
                    },
                ),
                ("needs", Value::Array(c.needs.iter().map(|group| strings(group)).collect())),
                (
                    "allAttrs",
                    Value::Array(c.all_attrs().iter().map(|(name, _)| Value::String((*name).to_owned())).collect()),
                ),
            ])
        })
        .collect();
    let got = [
        ("tones", strings(GENUI_TONES)),
        ("icons", strings(GENUI_ICONS)),
        ("limits", limits),
        ("entityTypes", strings(ENTITY_TYPES)),
        ("actionKinds", strings(ACTION_KINDS)),
        ("presentKeys", strings(PRESENT_KEYS)),
        ("groups", Value::Array(COMPONENT_GROUPS.iter().map(|g| Value::String(g.as_str().to_owned())).collect())),
        ("globalAttrs", attr_list(GLOBAL_ATTRS)),
        ("collectionAttrs", attr_list(COLLECTION_ATTRS)),
        ("components", Value::Array(components)),
        ("exprFunctions", strings(EXPR_FUNCTIONS)),
        ("exprRoots", strings(EXPR_ROOTS)),
        ("exprMaxLength", n(EXPR_MAX_LENGTH)),
        ("rawTextTags", strings(RAW_TEXT_TAGS)),
        ("offText", Value::String(eos_genui::spec::GENUI_OFF_TEXT.to_owned())),
    ];
    let expected = expected.as_object().expect("catalog.json");
    assert_eq!(expected.len(), got.len(), "catalog.json has keys this test does not compare");
    for (key, value) in got {
        if key == "components" {
            // Named one by one, so a difference points at its component.
            let (Some(Value::Array(want)), Value::Array(have)) = (expected.get(key), &value) else {
                panic!("components")
            };
            assert_eq!(want.len(), have.len(), "number of components");
            for (w, h) in want.iter().zip(have) {
                assert_eq!(w, h, "component {}", h.get("name").and_then(Value::as_str).unwrap_or("?"));
            }
            continue;
        }
        assert_eq!(expected.get(key), Some(&value), "{key}");
    }
}
