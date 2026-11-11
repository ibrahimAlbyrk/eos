//! Rules about git state that need no repository: names, orderings, and what
//! a push or a pull should do given where a branch stands.

pub mod branch_name;
pub mod branch_order;
pub mod changes;
pub mod conflict;
pub mod project_key;
pub mod pull_plan;
pub mod push_plan;
pub mod remote_ref;
