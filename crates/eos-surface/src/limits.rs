//! How big a surface's parts may grow and how much of its history is kept.

/// A Page design's parts.
pub const TEMPLATE_BYTES: usize = 64 * 1024;
pub const STYLE_BYTES: usize = 32 * 1024;
pub const CONTRACT_BYTES: usize = 16 * 1024;
pub const SAMPLE_BYTES: usize = 128 * 1024;

/// One issue's data, as compact JSON.
pub const ISSUE_DATA_BYTES: usize = 128 * 1024;
pub const IMAGES_PER_ISSUE: usize = 24;
/// The image store of one surface; the oldest unreferenced images go first.
pub const IMAGE_STORE_BYTES: u64 = 300 * 1024 * 1024;

/// Saved state of one scope of a Page or a View, and of an App.
pub const STATE_BYTES: usize = 32 * 1024;
pub const APP_STATE_BYTES: usize = 256 * 1024;

/// Issues kept per surface besides the ones the user marked Keep.
pub const KEPT_ISSUES: usize = 100;
/// Versions kept per surface besides every one an issue still uses.
pub const KEPT_VERSIONS: usize = 30;
/// A trial issue is dropped this long after its routine starts.
pub const TRIAL_ISSUE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Refused fills a run may make before Eos builds a fallback View.
pub const FILL_ATTEMPTS: u32 = 3;
/// Actions one surface may run in a second.
pub const ACTIONS_PER_SECOND: u32 = 5;
/// How long an Eos confirmation of an action stays good.
pub const CONFIRM_TOKEN_MS: i64 = 2 * 60 * 1000;

/// The tiles on Home.
pub const PIN_SLOTS: u8 = 3;

/// The phone's document stays under this, so its frame through the relay
/// stays under 5 MB; images past it are drawn as their alt text.
pub const PHONE_DOCUMENT_BYTES: usize = 3_500_000;
pub const PHONE_IMAGE_WIDTH: u32 = 800;
/// A mail is laid out this wide; its images are at most 600 px and 5 MB in all.
pub const MAIL_WIDTH: u16 = 640;
pub const MAIL_IMAGE_WIDTH: u32 = 600;
pub const MAIL_IMAGE_BYTES: usize = 5 * 1024 * 1024;
