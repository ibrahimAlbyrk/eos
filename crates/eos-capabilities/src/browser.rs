//! The `browser` built-in: an entry that describes the browser agents
//! already drive through their `browser_*` tools, so the capability list
//! and `list_capabilities` show it. It adds no way in: its only action is
//! its health check, and the tools keep the policy they have. It is
//! healthy while the app has a window whose views the tools drive.

use eos_core::BoxFuture;
use eos_core::capability::{ActionContext, ActionError, BuiltinCapability};
use eos_domain::capability::health::Event;
use eos_domain::capability::manifest::Manifest;
use serde_json::{Value, json};

/// The capability's id.
pub const BROWSER: &str = "browser";

pub struct Browser {
    manifest: Manifest,
    /// The app has a window whose views the tools drive.
    views: bool,
}

impl std::fmt::Debug for Browser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Browser").field("views", &self.views).finish_non_exhaustive()
    }
}

fn manifest() -> Manifest {
    let manifest = json!({
        "id": BROWSER,
        "name": "Browser",
        "version": "1",
        "summary": "Web pages in Eos's own window, through the browser_* tools: open a tab, navigate, read the page \
                    (browser_snapshot, browser_get, browser_find), click, type and fill forms (browser_act, \
                    browser_type, browser_fill_form), scroll, wait and take screenshots.",
        "form": "builtin",
        "works": "this_mac",
        "health": { "action": "check" },
        "actions": [
            { "name": "check", "summary": "See that Eos's window can show web pages.", "class": "read",
              "output": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] } },
        ],
    });
    // A test holds the manifest to the built-in check; this never fails.
    serde_json::from_value(manifest).unwrap_or_else(|e| panic!("the browser manifest does not parse: {e}"))
}

impl Browser {
    pub fn new(views: bool) -> Self {
        Self { manifest: manifest(), views }
    }
}

impl BuiltinCapability for Browser {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        action: &'a str,
        _input: Value,
        _ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        let answer = match action {
            "check" => Ok(json!({ "ok": self.views })),
            _ => Err(ActionError::NotFound),
        };
        Box::pin(std::future::ready(answer))
    }

    fn health<'a>(&'a self, _ctx: &'a ActionContext) -> BoxFuture<'a, Event> {
        Box::pin(std::future::ready(if self.views { Event::Passed } else { Event::CheckFailed }))
    }
}

#[cfg(test)]
mod tests {
    use eos_domain::capability::check::check_builtin;

    use super::*;

    #[tokio::test]
    async fn it_passes_the_check_and_is_healthy_only_with_a_window() {
        let ctx = ActionContext { secrets: Default::default(), settings: json!({}), idempotency_key: None };
        assert_eq!(check_builtin(Browser::new(true).manifest()), []);
        assert_eq!(Browser::new(true).health(&ctx).await, Event::Passed);
        assert_eq!(Browser::new(false).health(&ctx).await, Event::CheckFailed);
        assert_eq!(Browser::new(true).call("browser_navigate", json!({}), &ctx).await, Err(ActionError::NotFound));
    }
}
