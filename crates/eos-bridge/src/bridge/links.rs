//! A link the system handed the app (`eos://…`), carried out: the Connect sheet for an
//! invite, a place of the dashboard for the rest. Nothing a link asks for starts a run.

use serde_json::json;

use super::Bridge;
use crate::ask::ask;
use crate::core::Plane;
use crate::doors::{DoorItem, DoorPart, DoorSource};
use crate::links::{Link, Sent, issue_location, parse};
use crate::urlspace::percent_encode;

impl Bridge {
    /// Carries a link out on the page, once one listens; an `eos://send` link is held for the
    /// quick panel. What the link means is [`crate::links::parse`]'s; showing the window or the
    /// panel is the shell's.
    pub fn open_link(&self, url: &str) -> Link {
        let link = parse(url);
        match &link {
            Link::Pair => self.hosts_command("connect", Some(url)),
            Link::Open(route) => self.events.emit_or_wait("navigate", json!({ "route": route })),
            Link::Issue { id, button, index } => {
                // The link names the issue alone: its page is found first.
                let (core, me, target) =
                    (self.core.clone(), self.me.clone(), format!("/api/surface-issues/{}", percent_encode(id)));
                let (button, index) = (button.clone(), *index);
                self.rt.spawn(async move {
                    let token = core.ui_token();
                    let Ok((200, row)) = ask(&*core, Plane::Api, "GET", &target, &token, None).await else {
                        return;
                    };
                    let Some(surface) = row["surfaceId"].as_str() else { return };
                    let route = issue_location(surface, row["seq"].as_i64(), button.as_deref(), index);
                    if let Some(bridge) = me.upgrade() {
                        bridge.events.emit_or_wait("navigate", json!({ "route": route }));
                    }
                });
            }
            Link::Send(sent) => {
                let part = match sent {
                    Sent::Text(text) => DoorPart::Text(text.clone()),
                    Sent::Url(url) => DoorPart::Url(url.clone()),
                };
                self.hold(DoorItem::new(DoorSource::Link, None, vec![part]));
            }
            Link::Window => {}
        }
        link
    }
}
