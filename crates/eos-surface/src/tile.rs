//! A Page's tile on Home: slot texts over its contract (`"{lead.title}"`), read
//! from the newest issue. A design may leave it out; Home then shows the
//! surface's title and the routine's status line.

use serde_json::Value;

use crate::problem::Problem;
use crate::render::format::plain;
use crate::render::lookup;
use crate::template::{Scope, Seg, SlotType, parse_segments};
use crate::types::{Contract, Type};

#[derive(Debug, Clone, PartialEq)]
pub struct TileSpec {
    pub headline: Vec<Seg>,
    pub detail: Option<Vec<Seg>>,
    /// The words on the tile's button, which opens the surface (05 Q8).
    pub action: Option<Vec<Seg>>,
}

/// A tile's words for one issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileText {
    pub headline: String,
    pub detail: Option<String>,
    /// The words on the tile's button.
    pub action: Option<String>,
}

impl TileSpec {
    pub fn parse(json: &Value, contract: &Contract) -> Result<TileSpec, Vec<Problem>> {
        let mut problems = Vec::new();
        let scope = Scope::new(&contract.fields);
        let text = |key: &str, problems: &mut Vec<Problem>| -> Option<Vec<Seg>> {
            let raw = json.get(key)?;
            let Some(raw) = raw.as_str() else {
                problems.push(Problem::new(format!("tile.{key}"), "is text with slots"));
                return None;
            };
            let segs = match parse_segments(raw) {
                Ok(segs) => segs,
                Err(message) => {
                    problems.push(Problem::new(format!("tile.{key}"), message));
                    return None;
                }
            };
            for seg in &segs {
                let Seg::Slot(slot) = seg else { continue };
                match scope.resolve(&slot.path) {
                    Ok(resolved) if is_text(resolved.ty) => {}
                    Ok(_) => {
                        problems.push(Problem::new(format!("tile.{key}"), format!("{{{}}} is not text", slot.path)))
                    }
                    Err(message) => {
                        problems.push(Problem::new(format!("tile.{key}"), format!("{{{}}}: {message}", slot.path)))
                    }
                }
            }
            Some(segs)
        };
        let headline = text("headline", &mut problems);
        let detail = text("detail", &mut problems);
        let action = text("action", &mut problems);
        if headline.is_none() && problems.is_empty() {
            problems.push(Problem::new("tile.headline", "is required: text with slots"));
        }
        match (headline, problems.is_empty()) {
            (Some(headline), true) => Ok(TileSpec { headline, detail, action }),
            _ => Err(problems),
        }
    }

    /// The tile's words for an issue's data; an absent field reads as empty.
    pub fn text(&self, data: &Value, offset: i32) -> TileText {
        let fill = |segs: &[Seg]| -> String {
            segs.iter()
                .map(|seg| match seg {
                    Seg::Lit(text) => text.clone(),
                    Seg::Slot(slot) => {
                        lookup(data, &slot.path).map(|v| plain(v, slot.format.as_ref(), offset)).unwrap_or_default()
                    }
                })
                .collect::<String>()
                .trim()
                .to_owned()
        };
        TileText {
            headline: fill(&self.headline),
            detail: self.detail.as_deref().map(fill).filter(|d| !d.is_empty()),
            action: self.action.as_deref().map(fill).filter(|a| !a.is_empty()),
        }
    }
}

fn is_text(ty: SlotType<'_>) -> bool {
    match ty {
        SlotType::Of(ty) => matches!(
            ty,
            Type::Text { .. }
                | Type::LongText { .. }
                | Type::Number
                | Type::Int
                | Type::Date
                | Type::DateTime
                | Type::Enum { .. }
        ),
        SlotType::Text | SlotType::Int | SlotType::Date => true,
        SlotType::Url | SlotType::Any => false,
    }
}
