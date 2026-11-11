//! Everything in the shell that needs `unsafe`, and nothing else. The workspace denies
//! `unsafe` everywhere; this module tree is the one exception, for three reasons:
//!
//! - `buffer`: CEF hands the scheme handler a raw output buffer and callbacks that are
//!   reference-counted C++ objects; filling the buffer and moving the callbacks across
//!   threads has no safe form.
//! - `appkit`: z-order of child views, the first responder, the pasteboard and the open panel
//!   are AppKit calls Tauri has no API for.
//! - `notify`: banners go through `UNUserNotificationCenter`.
//!
//! Each function states what the caller must hold (usually: the main thread).
#![allow(unsafe_code)]

pub(crate) mod appkit;
pub(crate) mod buffer;
pub(crate) mod notify;
