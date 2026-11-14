//! The visual-answers catalog: entity, action and component definitions, the
//! limits, and [`validate_view`].

mod actions;
mod attr_check;
mod components;
mod data;
mod entities;
mod limits;
mod problems;
mod schema;
mod ui;
mod validate;

pub use components::{
    AttrDef, AttrKind, COLLECTION_ATTRS, COMPONENT_GROUPS, COMPONENTS, ChildPolicy, CollectionUse, ComponentDef,
    ComponentGroup, GLOBAL_ATTRS, component_def, component_names, is_component_name,
};
pub use entities::entity_issue_fields;
pub use limits::{
    ACTION_KINDS, ENTITY_TYPES, GENUI_ICONS, GENUI_LIMITS, GENUI_TONES, GenuiLimits, PRESENT_KEYS, is_genui_name,
    is_state_key,
};
pub use problems::{ViewProblem, format_problem, format_problems};
pub use validate::{CollectionStat, ViewStats, ViewValidation, stats_line, validate_view};

pub(crate) use limits::VIEW_ID_RE;
