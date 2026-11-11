//! Port of `contracts/src/http.ts` (symbols).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::de;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SymbolOccurrence {
    pub name: String,
    pub kind: String,
    pub role: SymbolOccurrenceRole,
    pub path: String,
    pub line: i64,
    pub column: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_text: Option<String>,
}

impl Validate for SymbolOccurrence {
    fn validate(&self, cx: &mut Issues) {
        cx.at("line", |cx| cx.int_min(self.line, 0, false));
        cx.at("column", |cx| cx.int_min(self.column, 0, false));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SymbolOccurrenceRole {
    Definition,
    Reference,
}

impl Validate for SymbolOccurrenceRole {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SymbolsLookupQuery {
    pub root: String,
    pub name: String,
    #[serde(default = "symbols_lookup_query_want_default")]
    pub want: SymbolsLookupQueryWant,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
}

fn symbols_lookup_query_want_default() -> SymbolsLookupQueryWant {
    SymbolsLookupQueryWant::Definitions
}

impl Validate for SymbolsLookupQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("name", |cx| cx.str_min(&self.name, 1));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SymbolsLookupQueryWant {
    Definitions,
    References,
}

impl Validate for SymbolsLookupQueryWant {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SymbolsLookupResponse {
    pub occurrences: Vec<SymbolOccurrence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexing: Option<bool>,
}

impl Validate for SymbolsLookupResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("occurrences", |cx| self.occurrences.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SymbolsSearchQuery {
    pub root: String,
    pub query: String,
    #[serde(default = "symbols_search_query_limit_default", deserialize_with = "de::coerce_int")]
    pub limit: i64,
}

fn symbols_search_query_limit_default() -> i64 {
    50
}

impl Validate for SymbolsSearchQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("query", |cx| cx.str_min(&self.query, 1));
        cx.at("limit", |cx| {
            cx.int_min(self.limit, 0, false);
            cx.int_max(self.limit, 200, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SymbolsSearchResponse {
    pub symbols: Vec<SymbolOccurrence>,
}

impl Validate for SymbolsSearchResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("symbols", |cx| self.symbols.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SymbolsFileQuery {
    pub root: String,
    pub path: String,
}

impl Validate for SymbolsFileQuery {
    fn validate(&self, cx: &mut Issues) {
        cx.at("root", |cx| cx.str_min(&self.root, 1));
        cx.at("path", |cx| cx.str_min(&self.path, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SymbolsFileResponse {
    pub occurrences: Vec<SymbolOccurrence>,
}

impl Validate for SymbolsFileResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("occurrences", |cx| self.occurrences.validate(cx));
    }
}
