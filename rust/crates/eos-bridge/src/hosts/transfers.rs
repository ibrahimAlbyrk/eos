//! `window.eosTransfer` in a host's view (`app/src/main/transfers.ts`). That page can only
//! reach its host, so this carries the few calls it needs to this computer's transfer
//! engine. The rules are held here, not trusted to the page:
//! - only a page running this computer's own dashboard gets through;
//! - the other side is always the host the page shows, never a value the page sends;
//! - this computer's paths come only from its own open panel: the page names paths on the
//!   host it shows, never one here.

use serde_json::{Value, json};

use super::HostViews;
use super::service::HostViewService;
use crate::ask::ask;
use crate::core::Plane;

type Outcome = Result<Value, (String, Option<String>)>;

fn fail(error: impl Into<String>) -> (String, Option<String>) {
    (error.into(), None)
}

const ACTIONS: [&str; 4] = ["pause", "resume", "cancel", "decide"];

/// Paths on the host the page shows: absolute strings, 1 to 500 of them.
fn host_paths(value: Option<&Value>) -> Result<Vec<String>, (String, Option<String>)> {
    let list = value.and_then(Value::as_array).filter(|l| !l.is_empty() && l.len() <= 500);
    let list = list.ok_or_else(|| fail("pick something to send"))?;
    list.iter()
        .map(|p| match p.as_str() {
            Some(p) if p.starts_with('/') && !p.contains('\0') => Ok(p.to_owned()),
            _ => Err(fail("bad path")),
        })
        .collect()
}

fn involves(transfer: &Value, host: &str) -> bool {
    let side = |key: &str| transfer.get(key).and_then(Value::as_str) == Some(host);
    side("from") || side("to")
}

/// One call on this computer's transfer routes, as its dashboard.
async fn engine(page: &HostViewService, method: &str, target: &str, body: Option<&Value>) -> Outcome {
    let token = page.core().ui_token();
    let (status, answer) = ask(page.core(), Plane::Api, method, target, &token, body).await.map_err(fail)?;
    if (200..300).contains(&status) {
        return Ok(answer);
    }
    let error = answer
        .get("error")
        .and_then(Value::as_str)
        .map_or_else(|| format!("transfer request failed ({status})"), str::to_owned);
    Err((error, answer.get("code").and_then(Value::as_str).map(str::to_owned)))
}

async fn list(page: &HostViewService) -> Result<Vec<Value>, (String, Option<String>)> {
    let all = engine(page, "GET", "/api/transfers", None).await?;
    Ok(all.get("transfers").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// A transfer this page may act on: one between this computer and the host it shows.
async fn mine(page: &HostViewService, id: &str) -> Outcome {
    let host = page.host_id();
    list(page)
        .await?
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(id) && involves(t, host))
        .ok_or_else(|| fail("not a transfer with this computer"))
}

pub(super) async fn call(page: &HostViewService, views: &HostViews, verb: &str, body: &Value) -> Outcome {
    if !page.trusted() {
        return Err((
            "Transfers from this view need the same Eos version on both Macs.".to_owned(),
            Some("needs-update".to_owned()),
        ));
    }
    let host = page.host_id().to_owned();
    let surface = &views.inner.parts.surface;
    match verb {
        "list" => Ok(Value::Array(list(page).await?.into_iter().filter(|t| involves(t, &host)).collect())),
        "destination" => {
            let paths = host_paths(body.get("paths"))?;
            let ask = json!({ "from": host, "to": "local", "paths": paths });
            engine(page, "POST", "/api/transfers/destination", Some(&ask)).await
        }
        "chooseFolder" => {
            let Some(dir) = surface.pick(true).await.and_then(|p| p.into_iter().next()) else { return Ok(Value::Null) };
            *page.chosen.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir.clone());
            Ok(json!({ "destDir": dir }))
        }
        // That computer → this one: into the folder picked here, else the engine's choice.
        "pull" => {
            let paths = host_paths(body.get("paths"))?;
            let chosen = body.get("chosen") == Some(&Value::Bool(true));
            let dest = if chosen { page.chosen.lock().unwrap_or_else(|p| p.into_inner()).clone() } else { None };
            let ask = json!({ "from": host, "to": "local", "paths": paths, "destDir": dest });
            engine(page, "POST", "/api/transfers", Some(&ask)).await
        }
        // This computer → that one: what is sent is what the user picks right now, here.
        "push" => {
            let dest = body.get("destDir").and_then(Value::as_str).filter(|d| d.starts_with('/')).map(str::to_owned);
            let Some(paths) = surface.pick(false).await.filter(|p| !p.is_empty()) else { return Ok(Value::Null) };
            let ask = json!({ "from": "local", "to": host, "paths": paths, "destDir": dest });
            engine(page, "POST", "/api/transfers", Some(&ask)).await
        }
        "act" => {
            let id = body.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
            let action = body.get("action").and_then(Value::as_str).unwrap_or("");
            if !ACTIONS.contains(&action) {
                return Err(fail("unknown action"));
            }
            mine(page, &id).await?;
            let decisions = json!({ "decisions": body.get("decisions").cloned().unwrap_or(json!({})) });
            let ask = if action == "decide" { decisions } else { json!({}) };
            let target = format!("/api/transfers/{}/{action}", crate::urlspace::percent_encode(&id));
            engine(page, "POST", &target, Some(&ask)).await
        }
        "clear" => engine(page, "DELETE", "/api/transfers", None).await,
        "reveal" => {
            let transfer = mine(page, body.get("id").and_then(Value::as_str).unwrap_or("")).await?;
            let placed = transfer.pointer("/placed/0/path").and_then(Value::as_str);
            if transfer.get("to").and_then(Value::as_str) == Some("local")
                && let Some(path) = placed
            {
                surface.reveal(path);
            }
            Ok(Value::Null)
        }
        _ => Err(fail("unknown transfer call")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_host_paths_are_taken() {
        assert_eq!(host_paths(Some(&json!(["/a", "/b c"]))).unwrap(), ["/a", "/b c"]);
        assert!(host_paths(Some(&json!([]))).is_err());
        assert!(host_paths(Some(&json!(["relative"]))).is_err());
        assert!(host_paths(Some(&json!(["/a\u{0}b"]))).is_err());
        assert!(host_paths(Some(&json!(vec!["/x"; 501]))).is_err());
        assert!(host_paths(None).is_err());
    }
}
