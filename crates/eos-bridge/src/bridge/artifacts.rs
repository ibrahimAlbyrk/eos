//! `window.eosArtifacts`: the dashboard's calls on the artifact views. Arguments are
//! checked here: the slug is always an artifact's uuid and the only page a view loads is
//! that uuid's viewer, never a URL the page sends. A call with arguments that do not hold
//! is answered as a no-op.

use serde_json::{Value, json};

use crate::artifacts::{ArtifactRef, ArtifactViews, login_id_of, parse_rect, slug_of, tab_key_of};

/// What `verb` answers; `None` when there is no such verb.
pub(super) async fn call(views: Option<&ArtifactViews>, verb: &str, body: &Value) -> Option<Value> {
    let artifact = || body.get("ref").and_then(ArtifactRef::parse);
    let rect = || body.get("rect").and_then(parse_rect);
    let tab_key = || tab_key_of(body.get("tabKey"));
    let slug = || body.get("slug").and_then(Value::as_str).and_then(slug_of);
    let login_id = || login_id_of(body.get("loginId"));
    let Some(views) = views else {
        // No window to show views in: every call is a no-op, as in a host view today.
        return known(verb).then(|| match verb {
            "state" => json!("idle"),
            "account" | "signIn" => json!({ "signedIn": false }),
            _ => Value::Null,
        });
    };
    let done = Value::Null;
    Some(match verb {
        "warm" => {
            if let Some(a) = artifact() {
                views.warm(a).await;
            }
            done
        }
        "peek" => {
            if let (Some(a), Some(r)) = (artifact(), rect()) {
                views.peek(a, r).await;
            }
            done
        }
        "unpeek" => {
            views.unpeek().await;
            done
        }
        "attach" => {
            if let (Some(t), Some(a), Some(r)) = (tab_key(), artifact(), rect()) {
                views.attach(t, a, r).await;
            }
            done
        }
        "setBounds" => {
            if let (Some(t), Some(r)) = (tab_key(), rect()) {
                views.set_bounds(t, r).await;
            }
            done
        }
        "setVisible" => {
            if let Some(t) = tab_key() {
                views.set_visible(t, body.get("visible") == Some(&Value::Bool(true))).await;
            }
            done
        }
        "detach" => {
            if let Some(t) = tab_key() {
                views.detach(t).await;
            }
            done
        }
        "reload" => {
            if let Some(s) = slug() {
                views.reload(s).await;
            }
            done
        }
        "still" => match artifact() {
            Some(a) => views.still(a).await.map_or(Value::Null, Value::String),
            None => Value::Null,
        },
        "state" => json!(match slug() {
            Some(s) => views.state(s).await.name(),
            None => "idle",
        }),
        "account" => views.account(login_id()).await,
        "signIn" => views.sign_in(login_id()).await,
        "signOut" => {
            views.sign_out(login_id()).await;
            done
        }
        _ => return None,
    })
}

fn known(verb: &str) -> bool {
    matches!(
        verb,
        "warm"
            | "peek"
            | "unpeek"
            | "attach"
            | "setBounds"
            | "setVisible"
            | "detach"
            | "reload"
            | "still"
            | "state"
            | "account"
            | "signIn"
            | "signOut"
    )
}
