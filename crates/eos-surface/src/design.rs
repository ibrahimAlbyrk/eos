//! A Page design version's body, read and checked as a whole: the template
//! against the contract, the style, the sample against the contract, and
//! every Button and Live part declared in `uses` and `queries`.

use serde_json::{Map, Value, json};

use crate::css::StyleSheet;
use crate::limits::{CONTRACT_BYTES, SAMPLE_BYTES};
use crate::problem::Problem;
use crate::template::PageTemplate;
use crate::tile::TileSpec;
use crate::types::Contract;
use crate::validate::validate;

/// The parts of a design as stored in `surface_versions.body`.
#[derive(Debug, Clone, PartialEq)]
pub struct PageDesign {
    pub template: PageTemplate,
    pub style: StyleSheet,
    pub contract: Contract,
    pub tile: Option<TileSpec>,
    pub uses: Vec<String>,
    pub queries: Vec<String>,
    pub sample: Value,
    /// The texts as written, kept so the body is stored as it came.
    source: Source,
}

#[derive(Debug, Clone, PartialEq)]
struct Source {
    template: String,
    style: String,
    contract: Value,
    tile: Option<Value>,
}

const KEYS: &[&str] = &["template", "style", "contract", "tile", "uses", "queries", "sample"];

impl PageDesign {
    /// Reads a body and runs the static checks; every problem at once.
    pub fn from_body(body: &Value) -> Result<PageDesign, Vec<Problem>> {
        let mut problems = Vec::new();
        let Some(map) = body.as_object() else {
            return Err(vec![Problem::new("", "a page design is an object")]);
        };
        for key in map.keys().filter(|k| !KEYS.contains(&k.as_str())) {
            problems.push(Problem::new(key.clone(), "is not part of a page design"));
        }
        let text = |key: &str, problems: &mut Vec<Problem>| match map.get(key) {
            Some(Value::String(text)) => text.clone(),
            _ => {
                problems.push(Problem::new(key, "is required: text"));
                String::new()
            }
        };
        let template_src = text("template", &mut problems);
        let style_src = text("style", &mut problems);
        let contract_json = map.get("contract").cloned().unwrap_or(Value::Null);
        if contract_json.to_string().len() > CONTRACT_BYTES {
            problems.push(Problem::new("contract", format!("is more than {CONTRACT_BYTES} bytes")));
        }
        let contract = Contract::parse(&contract_json).map_err(|found| {
            problems.extend(found.into_iter().map(|p| Problem::new(join("contract", &p.path), p.message)));
        });
        let uses = ids(map.get("uses"), "uses", &mut problems);
        let queries = ids(map.get("queries"), "queries", &mut problems);
        let sample = map.get("sample").cloned().unwrap_or(Value::Null);
        if sample.to_string().len() > SAMPLE_BYTES {
            problems.push(Problem::new("sample", format!("is more than {SAMPLE_BYTES} bytes")));
        }
        let style = StyleSheet::sanitize(&style_src).map_err(|found| problems.extend(found));
        let Ok(contract) = contract else { return Err(problems) };
        let template = PageTemplate::check(&template_src, &contract).map_err(|found| problems.extend(found));
        let tile = match map.get("tile") {
            None | Some(Value::Null) => None,
            Some(tile) => TileSpec::parse(tile, &contract).map_err(|found| problems.extend(found)).ok(),
        };
        for p in validate(&contract.as_type(), &sample).problems {
            problems.push(Problem::new(join("sample", &p.path), p.message));
        }
        if let Ok(template) = &template {
            for action in template.actions.iter().filter(|a| !uses.contains(a)) {
                problems.push(Problem::new("uses", format!("does not name {action}, which a Button runs")));
            }
            for query in template.queries.iter().filter(|q| !queries.contains(q)) {
                problems.push(Problem::new("queries", format!("does not name {query}, which a Live part reads")));
            }
        }
        let (Ok(template), Ok(style), true) = (template, style, problems.is_empty()) else { return Err(problems) };
        Ok(PageDesign {
            template,
            style,
            contract,
            tile,
            uses,
            queries,
            sample,
            source: Source {
                template: template_src,
                style: style_src,
                contract: contract_json,
                tile: map.get("tile").filter(|t| !t.is_null()).cloned(),
            },
        })
    }

    /// The body as stored, keys in their order.
    pub fn to_body(&self) -> Value {
        let mut out = Map::new();
        out.insert("template".into(), json!(self.source.template));
        out.insert("style".into(), json!(self.source.style));
        out.insert("contract".into(), self.source.contract.clone());
        if let Some(tile) = &self.source.tile {
            out.insert("tile".into(), tile.clone());
        }
        out.insert("uses".into(), json!(self.uses));
        out.insert("queries".into(), json!(self.queries));
        out.insert("sample".into(), self.sample.clone());
        Value::Object(out)
    }

    /// The template as written.
    pub fn template_source(&self) -> &str {
        &self.source.template
    }
}

fn join(parent: &str, path: &str) -> String {
    if path.is_empty() { parent.to_owned() } else { format!("{parent}.{path}") }
}

fn ids(value: Option<&Value>, key: &str, problems: &mut Vec<Problem>) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let id = item.as_str().map(str::to_owned);
                if id.is_none() {
                    problems.push(Problem::new(key, "is a list of ids"));
                }
                id
            })
            .collect(),
        Some(_) => {
            problems.push(Problem::new(key, "is a list of ids"));
            Vec::new()
        }
    }
}
