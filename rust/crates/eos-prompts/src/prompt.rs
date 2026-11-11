//! A prompt once read and checked (`core/src/domain/prompt.ts`,
//! `core/src/services/prompt-parse.ts`).

use eos_contracts::{DpiMeta, PromptFrontmatter, PromptLayer};
use eos_core::Error;
use eos_core::prompt::RawPrompt;
use serde_json::{Map, Value, json};

use crate::template::{Node, parse_template};

/// A prompt with valid frontmatter and a compiled body.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPrompt {
    pub id: String,
    pub frontmatter: PromptFrontmatter,
    pub body: String,
    pub nodes: Vec<Node>,
    /// The variables the body names.
    pub referenced: Vec<String>,
    /// Authoring notes that do not stop the prompt from being used: a
    /// variable used but not declared, a name that is not UPPER_SNAKE.
    pub warnings: Vec<String>,
}

/// A prompt that takes part in system prompts: it has a valid `dpi` block.
#[derive(Debug, Clone, PartialEq)]
pub struct Fragment {
    pub prompt: ParsedPrompt,
    pub dpi: DpiMeta,
}

/// `^[A-Z][A-Z0-9_]*$`.
fn is_upper_snake(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_uppercase())
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// A key that is there but null: today's check refuses it where a value of
/// another type is expected, so it is not "absent".
fn has_null(map: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|key| map.get(*key).is_some_and(Value::is_null))
}

/// Checks a prompt's frontmatter and compiles its body. Fails when the
/// frontmatter is not a mapping of the expected shape or the body is not a
/// valid template; the registry leaves such a prompt out.
pub fn parse_prompt(raw: &RawPrompt) -> Result<ParsedPrompt, Error> {
    let frontmatter = match &raw.frontmatter {
        Value::Null => Value::Object(Map::new()),
        other => other.clone(),
    };
    let checked = match &frontmatter {
        Value::Object(map) if !has_null(map, &["id", "description", "variables"]) => {
            eos_contracts::validate::parse::<PromptFrontmatter>(&frontmatter).map_err(|e| e.message())
        }
        Value::Object(_) => Err("a null where a value is expected".to_owned()),
        _ => Err("not a mapping".to_owned()),
    };
    let frontmatter =
        checked.map_err(|why| Error::Validation(format!("invalid frontmatter for prompt \"{}\": {why}", raw.id)))?;
    let template = parse_template(&raw.body)?;

    let declared: Vec<&str> = frontmatter.variables.iter().map(|v| v.0.as_str()).collect();
    let mut warnings = Vec::new();
    for name in &declared {
        if !is_upper_snake(name) {
            warnings.push(format!("variable \"{name}\" should be UPPER_SNAKE_CASE"));
        }
    }
    for name in &template.referenced {
        if !declared.contains(&name.as_str()) {
            warnings.push(format!("variable \"{name}\" is used but not declared"));
        }
    }
    Ok(ParsedPrompt {
        id: raw.id.clone(),
        frontmatter,
        body: raw.body.clone(),
        nodes: template.nodes,
        referenced: template.referenced,
        warnings,
    })
}

/// The prompt's `dpi` block, when it has a valid one. A prompt without is
/// still a template anyone may render by id.
pub fn dpi_of(prompt: &ParsedPrompt) -> Option<DpiMeta> {
    let dpi = prompt.frontmatter.dpi.as_ref()?;
    let map = dpi.as_object()?;
    if has_null(map, &["layer", "priority", "when", "overrides"]) {
        return None;
    }
    eos_contracts::validate::parse::<DpiMeta>(dpi).ok()
}

pub fn to_fragment(prompt: ParsedPrompt) -> Option<Fragment> {
    let dpi = dpi_of(&prompt)?;
    Some(Fragment { prompt, dpi })
}

/// A resolved worker definition's body as the fragment it becomes in its
/// worker's prompt (`definition/<name>`, role layer, priority 20). `None`
/// for a blank body, and for one that is not a valid template: a broken
/// definition must not stop its worker from starting.
pub fn definition_fragment(name: &str, body: &str) -> Option<Fragment> {
    if name.is_empty() || crate::template::js_trim(body).is_empty() {
        return None;
    }
    let raw = RawPrompt {
        id: format!("definition/{name}"),
        frontmatter: json!({ "dpi": { "layer": "role", "priority": 20 }, "variables": [] }),
        body: body.to_owned(),
        source_path: None,
    };
    to_fragment(parse_prompt(&raw).ok()?)
}

/// A layer's place in the assembled prompt.
pub(crate) fn layer_rank(layer: PromptLayer) -> u8 {
    match layer {
        PromptLayer::Core => 0,
        PromptLayer::Environment => 1,
        PromptLayer::Role => 2,
        PromptLayer::Tool => 3,
        PromptLayer::Safety => 4,
        PromptLayer::Custom => 5,
    }
}

/// A layer's name on the wire.
pub fn layer_name(layer: PromptLayer) -> &'static str {
    match layer {
        PromptLayer::Core => "core",
        PromptLayer::Environment => "environment",
        PromptLayer::Role => "role",
        PromptLayer::Tool => "tool",
        PromptLayer::Safety => "safety",
        PromptLayer::Custom => "custom",
    }
}
