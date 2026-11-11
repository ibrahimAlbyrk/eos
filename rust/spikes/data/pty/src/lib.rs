//! Spike 10: a PTY (`portable-pty`) and a terminal-state mirror that can be
//! serialized for a reattaching client, as manager/services/pty/screenMirror.ts
//! does today with @xterm/headless and its serialize addon.

pub mod mirror;
