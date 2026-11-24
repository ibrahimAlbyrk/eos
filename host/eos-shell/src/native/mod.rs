//! Everything in the shell that needs `unsafe`, and nothing else. The workspace denies
//! `unsafe` everywhere; this module tree is the one exception, for these reasons:
//!
//! - `buffer`: CEF hands the scheme handler a raw output buffer and callbacks that are
//!   reference-counted C++ objects; filling the buffer and moving the callbacks across
//!   threads has no safe form.
//! - `appkit`: z-order of child views, the first responder, the pasteboard, the open panel and
//!   the error alert are AppKit calls Tauri has no API for.
//! - `notify`: banners go through `UNUserNotificationCenter`.
//! - `activity`: the work hold's `NSProcessInfo` activity, whose token moves between threads
//!   and is handed back to end it.
//! - `launch`: the Apple Event the app was launched with, read from `NSAppleEventManager`.
//! - `dock`: the number on the Dock icon, through `NSApp.dockTile`.
//! - `login`: the login item, through `SMAppService`.
//! - `panel`: the quick panel's `NSPanel` floated over every app, placed and shown without
//!   activating the app.
//!
//! Each function states what the caller must hold (usually: the main thread).
#![allow(unsafe_code)]

pub(crate) mod activity;
pub(crate) mod appkit;
pub(crate) mod buffer;
pub(crate) mod dock;
pub(crate) mod launch;
pub(crate) mod login;
pub(crate) mod notify;
pub(crate) mod panel;
