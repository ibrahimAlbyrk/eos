//! What a slot's path names where it stands: a field of the contract, a repeat's
//! item, one of Eos's `issue.*` names, or inside a `Live` part `query.*`.

use crate::types::{Field, Type};

use super::rules::ISSUE_FIELDS;

/// The type a path ends on.
#[derive(Debug, Clone, Copy)]
pub(crate) enum SlotType<'a> {
    Of(&'a Type),
    /// An image's `alt` or `credit`, or the reader's name.
    Text,
    /// An image's `src`.
    Url,
    Int,
    Date,
    /// A query's answer, typed by the query, not by the contract.
    Any,
}

#[derive(Debug, Clone)]
pub(crate) struct Resolved<'a> {
    pub(crate) ty: SlotType<'a>,
    /// The path in the contract's own terms: `stories[].image.alt`.
    pub(crate) canon: String,
    /// Every optional field the path passes through, in the same terms.
    pub(crate) optionals: Vec<String>,
}

#[derive(Debug, Clone)]
struct Item<'a> {
    name: String,
    ty: &'a Type,
    canon: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Scope<'a> {
    fields: &'a [Field],
    items: Vec<Item<'a>>,
    pub(crate) in_live: bool,
    /// The canonical paths an `if=` or a repeat above guarantees.
    pub(crate) guards: Vec<String>,
}

impl<'a> Scope<'a> {
    pub(crate) fn new(fields: &'a [Field]) -> Self {
        Scope { fields, items: Vec::new(), in_live: false, guards: Vec::new() }
    }

    pub(crate) fn repeats(&self) -> usize {
        self.items.len()
    }

    pub(crate) fn takes_name(&self, name: &str) -> bool {
        self.items.iter().any(|i| i.name == name)
            || self.fields.iter().any(|f| f.name == name)
            || matches!(name, "issue" | "query")
    }

    /// A repeat over the list at `list`, its items named `name`.
    pub(crate) fn enter_repeat(&mut self, name: &str, list: &Resolved<'a>) -> Result<(), String> {
        let SlotType::Of(Type::List { of, .. }) = list.ty else {
            return Err(format!("{} is not a list", list.canon));
        };
        self.guards.push(list.canon.clone());
        self.items.push(Item { name: name.to_owned(), ty: of, canon: format!("{}[]", list.canon) });
        Ok(())
    }

    pub(crate) fn is_guarded(&self, optional: &str) -> bool {
        self.guards
            .iter()
            .any(|g| g == optional || g.strip_prefix(optional).is_some_and(|rest| rest.starts_with(['.', '['])))
    }

    pub(crate) fn resolve(&self, path: &str) -> Result<Resolved<'a>, String> {
        let mut names = path.split('.');
        let first = names.next().unwrap_or_default();
        let mut optionals = Vec::new();
        let (mut ty, mut canon) = if let Some(item) = self.items.iter().rev().find(|i| i.name == first) {
            (item.ty, item.canon.clone())
        } else if first == "issue" {
            let name = names.next().unwrap_or_default();
            let ty = match name {
                "seq" => SlotType::Int,
                "date" => SlotType::Date,
                "reader" => SlotType::Text,
                _ => return Err(format!("issue.{name} is not a name Eos fills: {}", issue_names())),
            };
            if let Some(more) = names.next() {
                return Err(format!("issue.{name}.{more} names nothing"));
            }
            return Ok(Resolved { ty, canon: format!("issue.{name}"), optionals });
        } else if first == "query" {
            if !self.in_live {
                return Err("query.… is read only inside a Live part".into());
            }
            return Ok(Resolved { ty: SlotType::Any, canon: path.to_owned(), optionals });
        } else if let Some(field) = self.fields.iter().find(|f| f.name == first) {
            if !field.required {
                optionals.push(field.name.clone());
            }
            (&field.ty, field.name.clone())
        } else if first == "item" {
            return Err("item is read only inside a repeat (each=)".into());
        } else {
            return Err(format!("{first} is not a field of the contract"));
        };
        for name in names {
            match ty {
                Type::Object { fields } => {
                    let Some(field) = fields.iter().find(|f| f.name == name) else {
                        return Err(format!("{canon} has no field {name}"));
                    };
                    canon = format!("{canon}.{name}");
                    if !field.required {
                        optionals.push(canon.clone());
                    }
                    ty = &field.ty;
                }
                Type::Image => {
                    let sub = match name {
                        "src" => SlotType::Url,
                        "alt" => SlotType::Text,
                        "credit" => SlotType::Text,
                        _ => return Err(format!("{canon} is an image: it has src, alt and credit")),
                    };
                    canon = format!("{canon}.{name}");
                    if name == "credit" {
                        optionals.push(canon.clone());
                    }
                    return Ok(Resolved { ty: sub, canon, optionals });
                }
                Type::List { .. } => return Err(format!("{canon} is a list: repeat it with each=")),
                _ => return Err(format!("{canon} is a {}: it has no field {name}", ty.name())),
            }
        }
        Ok(Resolved { ty: SlotType::Of(ty), canon, optionals })
    }
}

fn issue_names() -> String {
    ISSUE_FIELDS.iter().map(|n| format!("issue.{n}")).collect::<Vec<_>>().join(", ")
}
