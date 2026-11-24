//! What routines ask of surfaces: the designed view, page or app a routine
//! makes follows the routine through its life (05 §4).

use crate::{BoxFuture, Error};

/// The surface of a routine whose blueprint makes a view, a page or an app.
/// Each call comes after the routine's own write committed; a failure here
/// never undoes it.
pub trait SurfaceAuthoring: Send + Sync {
    /// A routine was created: its surface starts from `version_id`'s
    /// blueprint, which makes `makes`.
    fn create_for_routine<'a>(
        &'a self,
        routine_id: &'a str,
        version_id: &'a str,
        makes: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine started: the surface's candidate becomes its first kept
    /// version.
    fn keep<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine was archived or deleted.
    fn archive_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine came back from the archive or from Recently deleted.
    fn restore_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The routine left for good: its surfaces' folders go to the trash and
    /// their rows go.
    fn remove_for_routine<'a>(&'a self, routine_id: &'a str) -> BoxFuture<'a, Result<(), Error>>;
}

/// Runs a surface's direct action the way a press of its button does: the
/// dispatcher resolves the arguments from the stored issue, passes the gate
/// and keeps the record. For Needs you's cards and the phone.
pub trait DirectActions: Send + Sync {
    /// `origin`: `dashboard`, `phone`, `mail_link` or `app`.
    fn run<'a>(
        &'a self,
        request: eos_contracts::ActionRunRequest,
        origin: &'a str,
    ) -> BoxFuture<'a, Result<eos_contracts::ActionAnswer, Error>>;
}

/// What a run hands back with `return_view`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReturnedView {
    /// `result` or `question`.
    pub place: String,
    /// The View as `present` takes it.
    pub view: serde_json::Value,
    /// `{viewActionId: {action, args}}`: what each `send` runs.
    pub bindings: Option<serde_json::Value>,
}

/// The surface tools of a run's sessions.
pub trait SurfaceTools: Send + Sync {
    /// Stores the View as an issue of the caller's routine's View surface and
    /// answers the line the agent reads; every problem is a validation error
    /// listing them all.
    fn return_view<'a>(&'a self, worker_id: &'a str, view: ReturnedView) -> BoxFuture<'a, Result<String, Error>>;
    /// Stores the data as the run's issue of its routine's Page and answers
    /// the line the agent reads; every problem is a validation error listing
    /// them all. Null data answers the contract the run fills, and a sample.
    fn fill_page<'a>(&'a self, worker_id: &'a str, data: serde_json::Value) -> BoxFuture<'a, Result<String, Error>>;
    /// What a design run's designer works from: the page's current version,
    /// what the user asked and pointed at, and its newest issues' data.
    fn page_design_read<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<serde_json::Value, Error>>;
    /// Checks a design the designer proposes and, when the static checks
    /// pass, makes it the page's candidate once the probe passes it; the
    /// line the agent reads, or every problem as a validation error.
    fn page_design_propose<'a>(
        &'a self,
        worker_id: &'a str,
        design: serde_json::Value,
        note: String,
    ) -> BoxFuture<'a, Result<String, Error>>;
}

/// A returned View as Needs you shows it (03 §4.5): a `question` View is a
/// question its run waits on; a `result` View a card the user can put aside.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewCard {
    pub routine_id: String,
    pub run_id: String,
    pub surface_id: String,
    pub issue_id: String,
    pub question: bool,
    pub title: String,
    pub summary: String,
    /// The user started the run by hand.
    pub by_hand: bool,
}

/// Needs you's items for returned Views, handed to the surfaces at composition.
pub trait ViewCards: Send + Sync {
    /// Opens the View's item inside the job that stores its issue; its id.
    fn open_in(
        &self,
        tx: &dyn crate::store::Tx,
        out: &mut crate::store::Outbox,
        now: i64,
        card: &ViewCard,
    ) -> Result<String, Error>;
    /// Waits, without a limit, for the answer to a question View's item:
    /// what the user pressed, as its run reads it. Its item is taken back
    /// when the waiter stops waiting.
    fn heard<'a>(&'a self, item_id: &'a str) -> BoxFuture<'a, String>;
    /// Answers a question View's item with what the user pressed.
    fn answer<'a>(&'a self, item_id: &'a str, pressed: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// Opens, inside the job that stores a second fallback in a row, the one
    /// item that says the routine's page needs a redesign.
    #[allow(clippy::too_many_arguments)]
    fn redesign_in(
        &self,
        tx: &dyn crate::store::Tx,
        out: &mut crate::store::Outbox,
        now: i64,
        routine_id: &str,
        run_id: &str,
        surface_id: &str,
        title: &str,
    ) -> Result<String, Error>;
}

/// Where an image of a page issue comes from: an http(s) URL in its data, or
/// a file in the run's own output folder (never another path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageSource {
    Url(String),
    RunFile(std::path::PathBuf),
}

/// An image the store holds: named by the SHA-256 of what it wrote.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub hash: String,
    /// `image/jpeg` or `image/png`.
    pub content_type: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Why an image of an issue could not be had; the page then shows its alt
/// text in its place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFailure {
    Unreachable,
    TooLarge,
    NotAnImage,
    Unreadable,
}

impl ImageFailure {
    pub fn reason(self) -> &'static str {
        match self {
            ImageFailure::Unreachable => "could not be fetched",
            ImageFailure::TooLarge => "is larger than 10 MB",
            ImageFailure::NotAnImage => "is not a JPEG, PNG, GIF or WebP image",
            ImageFailure::Unreadable => "could not be read",
        }
    }
}

/// An image as it is served or inlined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredImage {
    pub content_type: String,
    pub body: bytes::Bytes,
}

/// The images of routine surfaces under `surfaces/<id>/img/`: fetched or read
/// once when an issue is filled, decoded, scaled and written again (which
/// drops EXIF and location), so a page never fetches anything when it is
/// read.
pub trait SurfaceImages: Send + Sync {
    fn intake<'a>(&'a self, surface_id: &'a str, src: ImageSource) -> BoxFuture<'a, Result<ImageRef, ImageFailure>>;
    /// The image by its hash; `max_width` scales it down (as JPEG or PNG
    /// again) for the phone and mail.
    fn read<'a>(
        &'a self,
        surface_id: &'a str,
        hash: &'a str,
        max_width: Option<u32>,
    ) -> BoxFuture<'a, Result<Option<StoredImage>, Error>>;
    /// Removes every image of the surface not in `keep`; the bytes freed.
    fn collect<'a>(&'a self, surface_id: &'a str, keep: &'a [String]) -> BoxFuture<'a, Result<u64, Error>>;
}

/// A page issue as mail (05 Q9), for the mail channel at send time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailDocument {
    pub subject: String,
    pub html: String,
    pub text: String,
    /// The images the html names as `cid:<cid>`.
    pub inline_images: Vec<InlineImage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineImage {
    pub cid: String,
    pub content_type: String,
    pub body: bytes::Bytes,
}

/// Draws a page issue for a channel that sends it.
pub trait SurfaceRender: Send + Sync {
    fn mail_document<'a>(&'a self, issue_id: &'a str) -> BoxFuture<'a, Result<MailDocument, Error>>;
}

/// A page the probe loads: a URL on the raw origin held a minute, and the
/// script it evaluates there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeDoc {
    pub url: String,
    pub script: String,
}

/// What the measuring script found at one width.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFinding {
    /// `readable`, `narrow` or `empty`.
    pub check: String,
    #[serde(default)]
    pub part: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeWidth {
    pub width: u16,
    pub findings: Vec<ProbeFinding>,
    /// A picture of the page at this width, for the designer to look at.
    pub screenshot: Option<std::path::PathBuf>,
}

/// The shell's hidden view that lays a page out as the dashboard would
/// (05 Q3): one page at a time, at each width, within its time limit.
/// Without Eos's window it is not available, and a candidate waits.
pub trait PageProbe: Send + Sync {
    fn is_available(&self) -> bool;
    /// Loads `doc` at each of `widths` and evaluates its script there;
    /// each screenshot is written into `shots`.
    fn measure<'a>(
        &'a self,
        doc: ProbeDoc,
        widths: &'a [u16],
        shots: &'a std::path::Path,
    ) -> BoxFuture<'a, Result<Vec<ProbeWidth>, Error>>;
}
