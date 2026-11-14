//! claude.ai Artifacts as live views over the dashboard.
//!
//! claude.ai and its content host refuse to be framed, so an artifact renders only as a
//! top-level page: the claude.ai viewer, in a child view of its own, in the profile of the
//! Claude sign-in that owns it. One live view per artifact moves between three places with
//! no reload: warm (off screen, loading), the hover peek (a half-zoom miniature whose
//! shield turns a click into "open") and a side-panel tab. A ready view that reloads stays
//! up while its replacement loads off screen; the two swap once the new one is ready.
//! While a view is not ready the dashboard paints its last still.
//!
//! [`ArtifactViews`] holds every rule and runs without a window; the shell lends it an
//! [`ArtifactSurface`] (create, place, park, capture a view) and reports what the views'
//! pages do as [`SurfaceEvent`]s. The dashboard reaches it through `/_shell/artifacts/*`.

mod manager;
pub mod pool;
pub mod stills;
pub mod urls;

use eos_core::BoxFuture;
use eos_core::shell::Rect;
use serde_json::Value;

pub use manager::{ArtifactViews, Emit};

/// A view the manager asked the surface for; named by the manager.
pub type ViewKey = u64;

/// Where an artifact view is in its life, as the dashboard knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewState {
    Idle,
    Loading,
    Ready,
    /// Its profile holds no claude.ai sign-in.
    Signin,
    Error,
}

impl ViewState {
    pub fn name(self) -> &'static str {
        match self {
            ViewState::Idle => "idle",
            ViewState::Loading => "loading",
            ViewState::Ready => "ready",
            ViewState::Signin => "signin",
            ViewState::Error => "error",
        }
    }
}

/// An artifact as the dashboard names it. Only the slug decides what loads: the page is
/// always that slug's viewer, never a URL the page sends.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArtifactRef {
    /// The artifact's uuid, lower case.
    pub slug: String,
    /// The Eos Claude sign-in whose list holds it.
    pub login_id: Option<String>,
    /// The live version; a new publish changes it.
    pub version: Option<String>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn capped(text: String, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The artifact's uuid, when `raw` is one.
pub fn slug_of(raw: &str) -> Option<String> {
    eos_contracts::short_id_of(raw).map(|_| raw.to_lowercase())
}

/// A sign-in id as the page sends it: `None` for none.
pub fn login_id_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| capped(s.to_owned(), 128))
}

impl ArtifactRef {
    /// The page's `{slug, loginId, url, version}`; a slug that is not a uuid is read from
    /// the URL, and nothing else names the artifact.
    pub fn parse(value: &Value) -> Option<Self> {
        let slug = text(value, "slug")
            .and_then(|s| slug_of(&s))
            .or_else(|| text(value, "url").and_then(|u| eos_contracts::artifact_slug_from_url(&u)))?;
        Some(Self {
            slug,
            login_id: login_id_of(value.get("loginId")),
            version: text(value, "version").map(|v| capped(v, 128)),
        })
    }
}

/// A rectangle as the page sends it, rounded to whole pixels; `None` unless every field is
/// a finite number.
pub fn parse_rect(value: &Value) -> Option<Rect> {
    let n = |key: &str| value.get(key).and_then(Value::as_f64).filter(|v| v.is_finite());
    let (x, y, width, height) = (n("x")?, n("y")?, n("width")?, n("height")?);
    Some(Rect { x: x.round(), y: y.round(), width: width.round().max(0.0), height: height.round().max(0.0) })
}

/// A side-panel tab's key: 1 to 256 characters.
pub fn tab_key_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 256).map(str::to_owned)
}

/// The profile of a Claude sign-in's claude.ai session: one per sign-in, since an artifact
/// opens only for its owner. Nothing in it comes from the user's own browsers.
pub fn profile_for(login_id: Option<&str>) -> String {
    match login_id {
        Some(id) => format!(
            "claude-{}",
            id.chars()
                .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
                .take(64)
                .collect::<String>()
        ),
        None => "claude".to_owned(),
    }
}

/// What a view's page did, as the shell reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceEvent {
    /// The main frame committed a document.
    Navigated {
        url: String,
    },
    /// The main frame shows an error page instead of `url`.
    Failed {
        description: String,
    },
    /// The page changed its address without a new document.
    InPage {
        url: String,
    },
    DomReady,
    Loaded,
    /// A main-frame navigation off the viewer was cancelled.
    Refused {
        url: String,
    },
    /// The page asked for a new window; none was opened.
    OpenRequested {
        url: String,
    },
    /// A trusted click on the peek's shield: `open`, or `external` with ⌥.
    Shield {
        external: bool,
    },
    /// The renderer is gone; `reason` as Chromium classifies it (`crashed`, `oom`, …).
    Crashed {
        reason: String,
    },
}

/// The window shell's side: child views in the main window, each created without a
/// bridge. Calls run in the order made; each returns once the shell has done it.
pub trait ArtifactSurface: Send + Sync + 'static {
    /// A new view in `profile`, off screen at the parked size, on a blank page. Its events
    /// arrive through [`ArtifactViews::surface_event`] under `view`.
    fn create(&self, view: ViewKey, profile: &str) -> BoxFuture<'_, Result<(), String>>;
    fn navigate(&self, view: ViewKey, url: &str) -> BoxFuture<'_, ()>;
    /// On screen at `rect` with rounded corners, above the dashboard and its other views.
    fn show(&self, view: ViewKey, rect: Rect, radius: f64) -> BoxFuture<'_, ()>;
    /// Off screen, laid out at `size` so the page keeps its layout (and can be captured).
    fn hide(&self, view: ViewKey, size: (f64, f64)) -> BoxFuture<'_, ()>;
    /// The hover peek: the page at half zoom under a shield that takes its input.
    fn set_peek(&self, view: ViewKey, peek: bool) -> BoxFuture<'_, ()>;
    fn set_muted(&self, view: ViewKey, muted: bool) -> BoxFuture<'_, ()>;
    /// Throttles a page nobody sees (its timers and its painting), or lets it run again.
    fn set_throttled(&self, view: ViewKey, throttled: bool) -> BoxFuture<'_, ()>;
    /// Back one page in the view's history; false when there is none.
    fn go_back(&self, view: ViewKey) -> BoxFuture<'_, bool>;
    /// The page as it is, as a JPEG at most 1600 pixels wide.
    fn capture(&self, view: ViewKey) -> BoxFuture<'_, Option<Vec<u8>>>;
    fn close(&self, view: ViewKey) -> BoxFuture<'_, ()>;
    /// Whether the profile holds a claude.ai sign-in: a `sessionKey` cookie. Nothing else
    /// of it is read.
    fn signed_in(&self, profile: &str) -> BoxFuture<'_, bool>;
    /// The site's account document, read by the browser with the profile's cookies (no page
    /// takes part); `None` when it does not answer.
    fn account(&self, profile: &str) -> BoxFuture<'_, Option<Value>>;
    /// The site's sign-in page, in a window of its own in `profile`. Resolves once the
    /// profile holds a sign-in and has left the sign-in pages (true), or when the user
    /// closes the window (whether it holds one then). One window per profile.
    fn sign_in(&self, profile: &str) -> BoxFuture<'_, bool>;
    /// Removes everything the profile stored.
    fn sign_out(&self, profile: &str) -> BoxFuture<'_, ()>;
    /// A web page in the user's own browser.
    fn open_external(&self, url: &str);
    /// The main window is on screen (shown and not minimized): a tab's sound plays only then.
    fn window_on_screen(&self) -> bool;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SLUG: &str = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn a_ref_is_named_by_its_uuid_only() {
        let parsed = ArtifactRef::parse(
            &json!({ "slug": SLUG.to_uppercase(), "loginId": "lg-1", "version": "v_1", "url": "https://evil.com" }),
        );
        assert_eq!(
            parsed,
            Some(ArtifactRef { slug: SLUG.into(), login_id: Some("lg-1".into()), version: Some("v_1".into()) })
        );
        let by_url =
            ArtifactRef::parse(&json!({ "url": "https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k", "loginId": "" }));
        assert_eq!(by_url.map(|r| (r.slug, r.login_id)), Some((SLUG.to_owned(), None)));
        assert_eq!(ArtifactRef::parse(&json!({ "slug": "not-a-uuid" })), None);
        assert_eq!(ArtifactRef::parse(&json!("x")), None);
    }

    #[test]
    fn rects_tabs_and_profiles() {
        assert_eq!(
            parse_rect(&json!({ "x": 10.4, "y": 20.6, "width": -3, "height": 99.5 })),
            Some(Rect { x: 10.0, y: 21.0, width: 0.0, height: 100.0 })
        );
        assert_eq!(parse_rect(&json!({ "x": 1, "y": 2, "width": 3 })), None);
        assert_eq!(tab_key_of(Some(&json!("artifact:abc"))), Some("artifact:abc".into()));
        assert_eq!(tab_key_of(Some(&json!(""))), None);
        assert_eq!(tab_key_of(Some(&json!("x".repeat(257)))), None);
        assert_eq!(profile_for(Some("lg/../1")), "claude-lg_.._1");
        assert_eq!(profile_for(None), "claude");
    }
}
