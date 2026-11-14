//! One Claude sign-in's claude.ai Artifacts, read from the undocumented frame
//! API Claude Code's own Artifact tool uses
//! (`infra/src/artifacts/FrameApiArtifactSource.ts`): the same family as the
//! usage endpoint, called with the sign-in's own token, which is never logged
//! or returned.
//!
//! Without `X-Frame-Surface` and `X-Frame-CP` the API answers 404. No user
//! agent of the CLI is sent: Eos does not pass itself off as another program.
//! Rows that are not a live artifact with a uuid slug are dropped, as the CLI
//! drops them.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{ArtifactSummary, ArtifactSummaryRel, artifact_viewer_url, short_id_of};
use eos_core::BoxFuture;
use eos_core::accounts::PlanAccess;
use eos_core::net::ArtifactSource;
use eos_kit_net::{ClientOptions, http_client};
use serde_json::Value;

const ANTHROPIC_API: &str = "https://api.anthropic.com";
const PROVIDER: &str = "anthropic";
/// Eos names itself: it does not pose as another program.
const USER_AGENT: &str = concat!("eos/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(15);

pub const NO_TOKEN_MESSAGE: &str = "This account isn't signed in — sign in again under Settings › Accounts.";
pub const REJECTED_MESSAGE: &str =
    "Claude no longer accepts this account's sign-in — sign in again under Settings › Accounts.";
const UNREADABLE_MESSAGE: &str = "The artifacts API sent an answer Eos can't read.";

/// Every Claude sign-in's artifacts, each read with that sign-in's token.
pub struct FrameApiArtifacts {
    http: reqwest::Client,
    url: String,
    access: Arc<dyn PlanAccess>,
}

impl std::fmt::Debug for FrameApiArtifacts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrameApiArtifacts").field("url", &self.url).finish_non_exhaustive()
    }
}

impl FrameApiArtifacts {
    pub fn new(access: Arc<dyn PlanAccess>) -> Self {
        Self::at(ANTHROPIC_API, access)
    }

    /// `base`: the API's origin (a local server in tests).
    pub fn at(base: &str, access: Arc<dyn PlanAccess>) -> Self {
        // The options are constants; a client that cannot be built is a broken TLS set-up.
        let http = http_client(&ClientOptions::new(USER_AGENT)).unwrap_or_default();
        Self { http, url: format!("{}/api/frame/frames?limit=200", base.trim_end_matches('/')), access }
    }

    async fn get(&self, token: &str) -> Result<reqwest::Response, String> {
        let request = self
            .http
            .get(&self.url)
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("accept", "application/json")
            .header("X-Frame-Surface", "code")
            .header("X-Frame-CP", "go")
            .timeout(TIMEOUT);
        request.send().await.map_err(|e| {
            if e.is_timeout() {
                format!("The artifacts API didn't answer within {} s.", TIMEOUT.as_secs())
            } else {
                format!("Couldn't reach the artifacts API: {}", e.without_url())
            }
        })
    }

    async fn token(&self, login_id: &str) -> Result<String, String> {
        let token = self.access.access_token(PROVIDER, login_id).await;
        token.ok_or_else(|| self.access.withheld().unwrap_or(NO_TOKEN_MESSAGE).to_owned())
    }

    async fn read(&self, login_id: &str) -> Result<Vec<ArtifactSummary>, String> {
        let token = self.token(login_id).await?;
        let mut res = self.get(&token).await?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            if !self.access.token_refused(PROVIDER, login_id, &token).await {
                return Err(REJECTED_MESSAGE.to_owned());
            }
            let renewed = self.token(login_id).await?;
            // An unchanged token would only be refused again.
            if renewed == token {
                return Err(REJECTED_MESSAGE.to_owned());
            }
            res = self.get(&renewed).await?;
        }
        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(REJECTED_MESSAGE.to_owned());
        }
        if !status.is_success() {
            return Err(format!("Couldn't read artifacts (HTTP {}).", status.as_u16()));
        }
        let body = res.bytes().await.map_err(|e| format!("Couldn't reach the artifacts API: {}", e.without_url()))?;
        let body: Value = serde_json::from_slice(&body).map_err(|_| UNREADABLE_MESSAGE.to_owned())?;
        let frames = body.get("frames").and_then(Value::as_array).ok_or_else(|| UNREADABLE_MESSAGE.to_owned())?;
        Ok(frames.iter().filter_map(|frame| artifact_summary(frame, login_id)).collect())
    }
}

impl ArtifactSource for FrameApiArtifacts {
    fn list<'a>(&'a self, login_id: &'a str) -> BoxFuture<'a, Result<Vec<ArtifactSummary>, String>> {
        Box::pin(self.read(login_id))
    }
}

/// A string with something besides white space in it.
fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

/// One row of the frame API as the catalog keeps it; `None` for a row that is
/// not a live artifact.
pub fn artifact_summary(row: &Value, login_id: &str) -> Option<ArtifactSummary> {
    row.as_object()?;
    if row.get("softDeleted") == Some(&Value::Bool(true)) {
        return None;
    }
    let slug = text(row, "slug")?.to_lowercase();
    short_id_of(&slug)?;
    let created_at = text(row, "created_at").map(str::to_owned);
    let updated_at = text(row, "updatedAt").map(str::to_owned).or_else(|| created_at.clone())?;
    let owned = |key: &str| text(row, key).map(str::to_owned);
    Some(ArtifactSummary {
        url: artifact_viewer_url(&slug),
        title: text(row, "title").map_or_else(|| "Untitled".to_owned(), |t| t.trim().to_owned()),
        favicon: owned("favicon"),
        tint: owned("tint"),
        kind: owned("type_title").unwrap_or_else(|| "Page".to_owned()),
        version: owned("live"),
        version_label: owned("label"),
        rel: if row.get("rel").and_then(Value::as_str) == Some("shared") {
            ArtifactSummaryRel::Shared
        } else {
            ArtifactSummaryRel::Mine
        },
        audience: owned("audience"),
        updated_at,
        created_at,
        login_id: login_id.to_owned(),
        slug,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    const SLUG: &str = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const SLUG2: &str = "5d7c1e40-9a1b-4c2d-8e3f-1a2b3c4d5e6f";

    fn live_row() -> Value {
        json!({
            "slug": SLUG, "title": "Quarterly plan", "favicon": "📈", "icon": "chart", "tint": "violet",
            "type_title": "Docs", "label": "Draft to legal", "live": "v_8f2a", "rel": "mine", "audience": "owner",
            "updatedAt": "2026-10-29T10:00:00.000Z", "created_at": "2026-10-20T09:00:00.000Z",
            "last_viewed_at": "2026-10-29T10:05:00.000Z", "thumbPending": false, "softDeleted": false,
        })
    }

    fn with(mut row: Value, key: &str, value: Value) -> Value {
        if let Some(o) = row.as_object_mut() {
            match value {
                Value::Null => o.remove(key),
                value => o.insert(key.to_owned(), value),
            };
        }
        row
    }

    // infra/src/__tests__/FrameApiArtifactSource.test.ts
    #[test]
    fn a_live_row_becomes_a_summary() {
        let summary = artifact_summary(&live_row(), "lg-1").unwrap();
        assert_eq!(
            serde_json::to_value(summary).unwrap(),
            json!({
                "slug": SLUG,
                "url": "https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k",
                "title": "Quarterly plan",
                "favicon": "📈",
                "tint": "violet",
                "kind": "Docs",
                "version": "v_8f2a",
                "versionLabel": "Draft to legal",
                "rel": "mine",
                "audience": "owner",
                "updatedAt": "2026-10-29T10:00:00.000Z",
                "createdAt": "2026-10-20T09:00:00.000Z",
                "loginId": "lg-1",
            })
        );
        assert_eq!(
            artifact_summary(&with(live_row(), "rel", json!("shared")), "lg-1").unwrap().rel,
            ArtifactSummaryRel::Shared
        );
    }

    #[test]
    fn drops_soft_deleted_slug_less_and_malformed_rows_and_fills_what_a_row_leaves_out() {
        let rows = [
            with(with(live_row(), "slug", json!(SLUG2)), "softDeleted", json!(true)),
            with(live_row(), "slug", json!("not-a-uuid")),
            with(live_row(), "slug", Value::Null),
            with(with(with(live_row(), "slug", json!(SLUG2)), "updatedAt", Value::Null), "created_at", Value::Null),
            Value::Null,
            json!("garbage"),
        ];
        for row in &rows {
            assert_eq!(artifact_summary(row, "lg-2"), None, "{row}");
        }
        let bare = json!({ "slug": SLUG2.to_uppercase(), "rel": "something-else", "created_at": "2026-10-01T00:00:00Z", "title": "  " });
        assert_eq!(
            serde_json::to_value(artifact_summary(&bare, "lg-2").unwrap()).unwrap(),
            json!({
                "slug": SLUG2,
                "url": "https://claude.ai/artifact/CYYhd2Q6dHFw5xpBekVHqY",
                "title": "Untitled",
                "kind": "Page",
                "rel": "mine",
                "updatedAt": "2026-10-01T00:00:00Z",
                "createdAt": "2026-10-01T00:00:00Z",
                "loginId": "lg-2",
            })
        );
    }
}
