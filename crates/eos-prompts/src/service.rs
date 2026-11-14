//! Rendering one prompt.

use std::sync::Arc;

use eos_core::Error;
use serde_json::Value;

use crate::prompt::ParsedPrompt;
use crate::registry::PromptRegistry;
use crate::template::{Node, VariableScope, parse_template, render_template};

/// Renders prompts with their variables. A name is looked up in the call's
/// own values first, then the session's, then the globals every render
/// shares (the tool names); one found nowhere renders as nothing.
pub struct PromptService {
    registry: Arc<PromptRegistry>,
    globals: VariableScope,
}

impl std::fmt::Debug for PromptService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptService").field("globals", &self.globals.len()).finish_non_exhaustive()
    }
}

/// An empty scope, for a render that passes no values of its own.
pub fn no_values() -> VariableScope {
    VariableScope::new()
}

impl PromptService {
    pub fn new(registry: Arc<PromptRegistry>, globals: VariableScope) -> Self {
        Self { registry, globals }
    }

    pub fn registry(&self) -> &Arc<PromptRegistry> {
        &self.registry
    }

    fn scope(&self, referenced: &[String], locals: &VariableScope, vars: &VariableScope) -> VariableScope {
        let mut scope = VariableScope::new();
        for name in referenced {
            let value = locals.get(name).or_else(|| vars.get(name)).or_else(|| self.globals.get(name));
            scope.insert(name.clone(), value.cloned().unwrap_or(Value::Null));
        }
        scope
    }

    fn render_nodes(
        &self,
        nodes: &[Node],
        referenced: &[String],
        locals: &VariableScope,
        vars: &VariableScope,
    ) -> String {
        render_template(nodes, &self.scope(referenced, locals, vars))
    }

    /// A library prompt by id. Fails when there is no such prompt.
    pub fn render(&self, id: &str, locals: &VariableScope, vars: &VariableScope) -> Result<String, Error> {
        Ok(self.render_parsed(&self.registry.get(id)?, locals, vars))
    }

    /// A prompt that is already parsed (a fragment made for one spawn, which
    /// the library does not hold).
    pub fn render_parsed(&self, prompt: &ParsedPrompt, locals: &VariableScope, vars: &VariableScope) -> String {
        self.render_nodes(&prompt.nodes, &prompt.referenced, locals, vars)
    }

    /// A template body that is not in the library (one from the user's
    /// settings). Fails when the body is not a valid template.
    pub fn render_inline(&self, body: &str, locals: &VariableScope, vars: &VariableScope) -> Result<String, Error> {
        let template = parse_template(body)?;
        Ok(self.render_nodes(&template.nodes, &template.referenced, locals, vars))
    }
}
