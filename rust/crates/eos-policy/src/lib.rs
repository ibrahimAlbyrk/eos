//! Permission decisions.
//!
//! Every tool call an agent makes passes [`PolicyGateway::decide`] (through
//! the `PolicyDecider` port for sessions, through `/policy/decide` for the
//! wire). [`evaluate`] is the decision itself, a pure function of the policy
//! file's rules, the worker's permission mode and the tool scope of its
//! definition; the gateway adds what needs the app: the worker's row, the
//! event trail, and asks that wait for the user.
//!
//! - [`rule`]: `policy.yaml` rules, compiled once ([`Policy`]).
//! - [`load`]: the policy document → the policy in force; saving a rule.
//! - [`mode`]: tool categories, permission modes, a worker's inherited mode.
//! - [`glob`]: the tool patterns of a worker definition's scope.
//! - [`evaluate`]: the rungs, in order.
//! - [`gateway`]: the stateful service.
//! - [`ask`]: the banner and the one-line summary of an ask.
//! - [`js`]: the JavaScript behaviour user-written rules depend on.

pub mod ask;
pub mod evaluate;
pub mod gateway;
pub mod glob;
pub mod js;
pub mod load;
pub mod mode;
pub mod rule;

pub use evaluate::{Call, evaluate};
pub use gateway::{Answer, GatewayOptions, PolicyGateway};
pub use js::JsRegex;
pub use load::{load_policy, with_tool_rule};
pub use mode::{ToolCategory, WorkerPermissions, classify_tool, worker_permissions};
pub use rule::{CompiledRule, Policy, compile_rule, evaluate_policy};
