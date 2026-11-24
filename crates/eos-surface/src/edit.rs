//! Edits in place (05 gap 22): a field the contract marks `edit` takes plain
//! text within its length, and a list it marks `edit` may be reordered or
//! shortened down to its `min`. Nothing else of an issue's data changes.

use serde_json::Value;

use crate::types::{Contract, Field, Type};

/// One edit, at a dotted path into the data (`lead.title`, `stories.2.title`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldEdit {
    Set { path: String, value: String },
    Move { path: String, from: usize, to: usize },
    Remove { path: String, index: usize },
}

impl FieldEdit {
    pub fn path(&self) -> &str {
        match self {
            FieldEdit::Set { path, .. } | FieldEdit::Move { path, .. } | FieldEdit::Remove { path, .. } => path,
        }
    }

    pub fn op(&self) -> &'static str {
        match self {
            FieldEdit::Set { .. } => "set",
            FieldEdit::Move { .. } => "move",
            FieldEdit::Remove { .. } => "remove",
        }
    }
}

/// The data after an edit, and the value at its path before and after.
#[derive(Debug, Clone, PartialEq)]
pub struct Edited {
    pub data: Value,
    pub before: Value,
    pub after: Value,
}

/// The field a path ends on, and whether the user may edit it.
fn field_at<'c>(contract: &'c Contract, path: &str) -> Result<(&'c Type, bool), String> {
    fn pick<'c>(fields: &'c [Field], name: &str) -> Option<(&'c Type, bool)> {
        fields.iter().find(|f| f.name == name).map(|f| (&f.ty, f.edit))
    }
    let missing = || format!("{path}: no such field");
    let mut at: Option<(&Type, bool)> = None;
    for name in path.split('.') {
        at = Some(match at {
            None => pick(&contract.fields, name).ok_or_else(missing)?,
            Some((Type::Object { fields }, _)) => pick(fields, name).ok_or_else(missing)?,
            Some((Type::List { of, .. }, _)) if name.parse::<usize>().is_ok() => (of.as_ref(), false),
            Some(_) => return Err(missing()),
        });
    }
    at.ok_or_else(missing)
}

fn at_mut<'v>(data: &'v mut Value, path: &str) -> Option<&'v mut Value> {
    path.split('.').try_fold(data, |at, name| match at {
        Value::Object(map) => map.get_mut(name),
        Value::Array(items) => items.get_mut(name.parse::<usize>().ok()?),
        _ => None,
    })
}

/// Applies one edit the contract allows; what is wrong otherwise.
pub fn apply_edit(contract: &Contract, data: &Value, edit: &FieldEdit) -> Result<Edited, String> {
    let path = edit.path();
    let (ty, editable) = field_at(contract, path)?;
    if !editable {
        return Err(format!("{path}: is not editable"));
    }
    let mut data = data.clone();
    let at = at_mut(&mut data, path).ok_or_else(|| format!("{path}: holds nothing"))?;
    let before = at.clone();
    match (edit, ty) {
        (FieldEdit::Set { value, .. }, Type::Text { max } | Type::LongText { max }) => {
            if matches!(ty, Type::Text { .. }) && value.contains('\n') {
                return Err(format!("{path}: is one line"));
            }
            if value.chars().count() > *max {
                return Err(format!("{path}: is at most {max} characters"));
            }
            *at = Value::String(value.clone());
        }
        (FieldEdit::Move { from, to, .. }, Type::List { .. }) => {
            let items = at.as_array_mut().ok_or_else(|| format!("{path}: is not a list"))?;
            if *from >= items.len() || *to >= items.len() {
                return Err(format!("{path}: holds {} items", items.len()));
            }
            let item = items.remove(*from);
            items.insert(*to, item);
        }
        (FieldEdit::Remove { index, .. }, Type::List { min, .. }) => {
            let items = at.as_array_mut().ok_or_else(|| format!("{path}: is not a list"))?;
            if *index >= items.len() {
                return Err(format!("{path}: holds {} items", items.len()));
            }
            if items.len() <= *min {
                return Err(format!("{path}: keeps at least {min} items"));
            }
            items.remove(*index);
        }
        (FieldEdit::Set { .. }, _) => return Err(format!("{path}: only text is edited in place")),
        _ => return Err(format!("{path}: only a list is reordered or shortened")),
    }
    let after = at.clone();
    Ok(Edited { data, before, after })
}
