//! A page issue with no script: for the phone's web view (05 Q10), where
//! buttons are `eos-action:` links the app sends at its own tier, and as a
//! file to share, where buttons are left out. Images and faces are inlined,
//! so the document loads nothing.

use super::frame::document;
use super::{Mode, RenderInput};

pub const PHONE_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/// `image_src` in `input` answers `data:` URIs.
pub fn phone_document(input: &RenderInput<'_>) -> String {
    document(input, Mode::Phone, PHONE_CSP, None)
}

pub fn share_document(input: &RenderInput<'_>) -> String {
    document(input, Mode::Share, PHONE_CSP, None)
}
