//! Who the user is, as prompt text.
//!
//! [`render_user_profile`] is the one place the user's profile and always-on
//! memories become text (`core/src/services/render-user-profile.ts`); its
//! output equals the TypeScript's byte for byte (`tests/render_vectors.rs`).
//! [`ProfileBlocks`] reads the stored profile and memories and renders them
//! for one session; it is what the spawn path and the profile preview share.

mod block;
mod render;

pub use block::{ProfileBlocks, build_user_profile_block, received_memory_lines};
pub use render::{
    DEFAULT_USER_PREFERENCES, MEMORY_BLOCK_HEADER, RenderOptions, RenderedUserProfile, drop_known_lines,
    known_line_set, render_user_profile,
};
