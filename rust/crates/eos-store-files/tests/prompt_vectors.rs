//! The prompt library and the system prompts assembled from it against
//! today's TypeScript (`rust/fixtures/prompts`, written by
//! `rust/tools/prompt-vectors/generate.mjs`): every prompt reads the same,
//! renders the same, and every assembled system prompt is byte-identical.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::{SessionFacts, SessionFactsRole};
use eos_core::prompt::PromptSource;
use eos_domain::{ProviderIdentity, TierSpec};
use eos_prompts::genui_level::genui_prompt_variables;
use eos_prompts::preview::{PreviewOptions, render_preview};
use eos_prompts::prompt::{dpi_of, layer_name};
use eos_prompts::service::no_values;
use eos_prompts::tiers::{default_effort_for, render_effort_section, render_model_tier_table};
use eos_prompts::tool_descriptions::render_tool_descriptions;
use eos_prompts::tool_names::{TOOL_NAME_VARS, tool_name_vars};
use eos_prompts::{
    DEFAULT_USER_PREFERENCES, PromptRegistry, PromptService, SessionSpawnContext, VariableScope,
    assemble_system_prompt, definition_fragment,
};
use eos_store_files::prompts::{EMBEDDED_PROMPTS, LibraryPromptSource};
use eos_testkit::TempHome;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/prompts")).join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
struct Prompt {
    id: String,
    file: String,
    frontmatter: Value,
    body: String,
}

#[derive(Deserialize)]
struct CatalogRow {
    id: String,
    description: Option<String>,
    layer: Option<String>,
    priority: Option<i64>,
    conditional: bool,
    variables: Vec<String>,
    referenced: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct Render {
    id: String,
    bare: String,
    locals: VariableScope,
    filled: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityData {
    persona: String,
    tiers: Vec<TierData>,
    default_tier: Option<String>,
    effort_supported: bool,
}

#[derive(Deserialize)]
struct TierData {
    name: String,
    model: String,
    hint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityCase {
    name: String,
    identity: IdentityData,
    default_tier: String,
    tier_table: String,
    effort_section: String,
    default_effort: String,
}

#[derive(Deserialize)]
struct GenuiCase {
    level: Option<String>,
    variables: VariableScope,
}

#[derive(Deserialize)]
struct PreviewOpts {
    role: String,
    provider: String,
    subagent: bool,
    worktree: bool,
    definition: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCase {
    opts: PreviewOpts,
    text: String,
    active_fragment_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    prompts: Vec<Prompt>,
    catalog: Vec<CatalogRow>,
    renders: Vec<Render>,
    tool_descriptions: BTreeMap<String, String>,
    tool_name_vars: serde_json::Map<String, Value>,
    genui_catalog_sha256: String,
    identities: Vec<IdentityCase>,
    genui: Vec<GenuiCase>,
    default_user_preferences: String,
    previews: Vec<PreviewCase>,
}

fn identity_of(data: &IdentityData) -> ProviderIdentity {
    ProviderIdentity {
        persona: data.persona.clone(),
        tiers: data
            .tiers
            .iter()
            .map(|t| TierSpec { name: t.name.clone(), model: t.model.clone(), hint: t.hint.clone() })
            .collect(),
        default_tier: data.default_tier.clone(),
        effort_supported: data.effort_supported,
    }
}

fn registry() -> Arc<PromptRegistry> {
    Arc::new(PromptRegistry::new(Arc::new(LibraryPromptSource::embedded())))
}

#[test]
fn the_shipped_library_is_the_typescript_trees() {
    let library: Library = fixture("library.json");
    let files: Vec<&str> = EMBEDDED_PROMPTS.iter().map(|(file, _)| *file).collect();
    let theirs: Vec<String> =
        library.prompts.iter().map(|p| format!("{}.prompt.md", p.file.trim_end_matches(".prompt.md"))).collect();
    assert_eq!(files, theirs, "the same files, walked in the same order");
    // While the TypeScript tree exists, the embedded copy is that tree.
    let tree = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../manager/prompts"));
    if tree.is_dir() {
        for (file, text) in EMBEDDED_PROMPTS {
            assert_eq!(std::fs::read_to_string(tree.join(file)).ok().as_deref(), Some(*text), "{file}");
        }
    }
}

#[test]
fn every_prompt_reads_and_renders_as_in_typescript() {
    let library: Library = fixture("library.json");
    assert!(library.prompts.len() >= 140);

    let raw = LibraryPromptSource::embedded().list();
    assert_eq!(raw.len(), library.prompts.len());
    for (ours, theirs) in raw.iter().zip(&library.prompts) {
        assert_eq!(ours.id, theirs.id);
        assert_eq!(ours.frontmatter, theirs.frontmatter, "{}", theirs.id);
        assert_eq!(ours.body, theirs.body, "{}", theirs.id);
    }

    let registry = registry();
    let parsed = registry.list();
    assert_eq!(parsed.len(), library.catalog.len(), "no prompt is skipped that TypeScript keeps");
    for (prompt, row) in parsed.iter().zip(&library.catalog) {
        let dpi = dpi_of(prompt);
        assert_eq!(prompt.id, row.id);
        assert_eq!(prompt.frontmatter.description, row.description, "{}", row.id);
        assert_eq!(dpi.as_ref().map(|d| layer_name(d.layer).to_owned()), row.layer, "{}", row.id);
        assert_eq!(dpi.as_ref().map(|d| d.priority), row.priority, "{}", row.id);
        assert_eq!(dpi.as_ref().is_some_and(|d| d.when.is_some()), row.conditional, "{}", row.id);
        assert_eq!(prompt.frontmatter.variables.iter().map(|v| v.0.clone()).collect::<Vec<_>>(), row.variables);
        assert_eq!(prompt.referenced, row.referenced, "{}", row.id);
        assert_eq!(prompt.warnings, row.warnings, "{}", row.id);
    }

    assert_eq!(sha(&eos_genui::catalog_prompt()), library.genui_catalog_sha256, "the visual-answer catalog");
    let mut globals = tool_name_vars();
    globals.insert("GENUI_CATALOG".into(), eos_genui::catalog_prompt().into());
    let prompts = PromptService::new(registry.clone(), globals);
    for render in &library.renders {
        assert_eq!(
            prompts.render(&render.id, &no_values(), &no_values()).expect("renders"),
            render.bare,
            "{}",
            render.id
        );
        assert_eq!(
            prompts.render(&render.id, &render.locals, &no_values()).expect("renders"),
            render.filled,
            "{}",
            render.id
        );
    }

    let names: Vec<&str> = library.tool_descriptions.keys().map(String::as_str).collect();
    let described: BTreeMap<String, String> = render_tool_descriptions(registry, &names).into_iter().collect();
    assert!(described.len() > 60);
    assert_eq!(described, library.tool_descriptions);
    assert_eq!(described["no_such_tool"], "no_such_tool", "a tool without a prompt keeps its bare name");
}

#[test]
fn tool_names_tiers_and_levels_as_in_typescript() {
    let library: Library = fixture("library.json");
    let ours: Vec<(String, Value)> = TOOL_NAME_VARS.iter().map(|(k, v)| ((*k).to_owned(), Value::from(*v))).collect();
    let theirs: Vec<(String, Value)> = library.tool_name_vars.into_iter().collect();
    assert_eq!(ours, theirs);
    assert_eq!(DEFAULT_USER_PREFERENCES, library.default_user_preferences);

    for case in &library.identities {
        let identity = identity_of(&case.identity);
        assert_eq!(identity.default_tier_name(), case.default_tier, "{}", case.name);
        assert_eq!(render_model_tier_table(&identity), case.tier_table, "{}", case.name);
        assert_eq!(render_effort_section(&identity), case.effort_section, "{}", case.name);
        assert_eq!(default_effort_for(&identity), case.default_effort, "{}", case.name);
    }
    // The offline preview, for the providers and switches the script takes.
    let prompts = PromptService::new(registry(), tool_name_vars());
    assert!(library.previews.len() >= 4);
    for preview in &library.previews {
        let provider = library.identities.iter().find(|i| i.name == preview.opts.provider).expect("a known provider");
        let options = PreviewOptions {
            role: if preview.opts.role == "orchestrator" {
                SessionFactsRole::Orchestrator
            } else {
                SessionFactsRole::Worker
            },
            identity: identity_of(&provider.identity),
            subagent: preview.opts.subagent,
            worktree: preview.opts.worktree,
            definition: preview.opts.definition.clone(),
            cwd: "{repo}".to_owned(),
        };
        let ours = render_preview(&prompts, &options);
        assert_eq!(
            ours.active_fragment_ids, preview.active_fragment_ids,
            "{} {}",
            preview.opts.role, preview.opts.provider
        );
        assert_eq!(ours.text, preview.text, "{} {}", preview.opts.role, preview.opts.provider);
    }

    for case in library.genui {
        assert_eq!(genui_prompt_variables(case.level.as_deref()), case.variables, "{:?}", case.level);
    }
}

#[derive(Deserialize)]
struct Definition {
    name: String,
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    ctx: SessionSpawnContext,
    definition: usize,
    sha256: String,
    length: usize,
    facts: SessionFacts,
    active_fragment_ids: Vec<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct Assembled {
    definitions: Vec<Definition>,
    cases: Vec<Case>,
}

#[test]
fn every_assembled_system_prompt_is_byte_identical() {
    let assembled: Assembled = fixture("assembled.json");
    assert!(assembled.cases.len() > 600, "the whole matrix");
    let prompts = PromptService::new(registry(), tool_name_vars());

    let mut failures = Vec::new();
    for (n, case) in assembled.cases.iter().enumerate() {
        let definition = &assembled.definitions[case.definition];
        let extra: Vec<_> = definition
            .body
            .as_deref()
            .and_then(|body| definition_fragment(&definition.name, body))
            .into_iter()
            .collect();
        let ours = assemble_system_prompt(&prompts, &case.ctx, extra);
        let about = format!(
            "#{n} {:?} definition {:?} plugins off {:?}",
            case.ctx.role, definition.name, case.ctx.disabled_plugins
        );
        if ours.active_fragment_ids != case.active_fragment_ids {
            failures.push(format!(
                "{about}: fragments\n  theirs {:?}\n  ours   {:?}",
                case.active_fragment_ids, ours.active_fragment_ids
            ));
            continue;
        }
        if ours.facts != case.facts {
            failures.push(format!("{about}: facts\n  theirs {:?}\n  ours   {:?}", case.facts, ours.facts));
        }
        if let Some(text) = &case.text
            && &ours.text != text
        {
            let at = ours.text.bytes().zip(text.bytes()).position(|(a, b)| a != b).unwrap_or(0);
            let show = |s: &str| s.get(at.saturating_sub(40)..).unwrap_or(s).chars().take(160).collect::<String>();
            failures.push(format!(
                "{about}: text differs at byte {at}\n  theirs {:?}\n  ours   {:?}",
                show(text),
                show(&ours.text)
            ));
        } else if sha(&ours.text) != case.sha256 {
            failures.push(format!("{about}: text differs (theirs {} UTF-16 units)", case.length));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        assembled.cases.len(),
        failures[..failures.len().min(8)].join("\n")
    );
}

#[test]
fn a_file_in_the_override_folder_replaces_or_adds_a_prompt() {
    let home = TempHome::new();
    home.write(
        "prompts/message-ids.prompt.md",
        "---\ndpi: { layer: core, priority: 5 }\n---\nThe user's own message-id rules.\n",
    );
    home.write("prompts/mine/extra.prompt.md", "---\nid: custom/extra\ndpi: { layer: custom, when: { fact: role, eq: worker } }\n---\nExtra for {{AGENT_NAME}}.\n");
    home.write("prompts/broken.prompt.md", "An unclosed {{#if X}} block");
    home.write("prompts/notes.md", "not a prompt");
    let source = LibraryPromptSource::with_overrides(vec![home.join("missing"), home.join("prompts")]);
    let raw = source.list();
    assert_eq!(raw.len(), EMBEDDED_PROMPTS.len() + 2, "one replaced, two added");
    let shipped_at = LibraryPromptSource::embedded().list().iter().position(|p| p.id == "message-ids");
    assert_eq!(raw.iter().position(|p| p.id == "message-ids"), shipped_at, "a replaced prompt keeps its place");

    let prompts = PromptService::new(Arc::new(PromptRegistry::new(Arc::new(source))), tool_name_vars());
    assert!(!prompts.registry().has("broken"), "a prompt that does not parse is left out");
    let ctx: SessionSpawnContext = serde_json::from_value(serde_json::json!({
        "role": "worker", "name": "Ada", "model": "opus", "permissionMode": "acceptEdits"
    }))
    .expect("a context");
    let assembled = assemble_system_prompt(&prompts, &ctx, Vec::new());
    assert!(assembled.text.contains("The user's own message-id rules."));
    assert!(assembled.text.ends_with("Extra for Ada.\n"));
    assert_eq!(assembled.active_fragment_ids.last().map(String::as_str), Some("custom/extra"));

    // An edit applies to the next assembly.
    home.write("prompts/mine/extra.prompt.md", "---\nid: custom/extra\ndpi: { layer: custom }\n---\nChanged.\n");
    assert!(assemble_system_prompt(&prompts, &ctx, Vec::new()).text.ends_with("Changed.\n"));
}
