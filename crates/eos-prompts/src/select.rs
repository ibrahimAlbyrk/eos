//! Which fragments make a session's prompt, and in what order.

use serde_json::{Map, Value};

use crate::condition::evaluate_condition;
use crate::prompt::{Fragment, layer_rank};

/// 1. Keeps the fragments whose `when` holds (or that have none).
/// 2. Drops every fragment a kept one `overrides`: a specific fragment
///    replaces a general one. A fragment cannot override itself.
/// 3. Orders by layer, then priority (low first), then id.
pub fn select_fragments(fragments: Vec<Fragment>, facts: &Map<String, Value>) -> Vec<Fragment> {
    let included: Vec<Fragment> = fragments
        .into_iter()
        .filter(|f| f.dpi.when.as_ref().is_none_or(|when| evaluate_condition(when, facts)))
        .collect();

    let dropped: Vec<String> = included
        .iter()
        .flat_map(|f| f.dpi.overrides.iter().flatten().filter(|id| **id != f.prompt.id).cloned())
        .collect();
    let mut surviving: Vec<Fragment> = included.into_iter().filter(|f| !dropped.contains(&f.prompt.id)).collect();

    surviving.sort_by(|a, b| {
        layer_rank(a.dpi.layer)
            .cmp(&layer_rank(b.dpi.layer))
            .then(a.dpi.priority.cmp(&b.dpi.priority))
            // As JavaScript compares strings: by UTF-16 code unit.
            .then_with(|| a.prompt.id.encode_utf16().cmp(b.prompt.id.encode_utf16()))
    });
    surviving
}
