//! Spike 10: a PTY (`portable-pty`) and a terminal-state mirror that can be
//! serialized for a reattaching client, as the 0.1.x app does with @xterm/headless and its serialize addon.

pub mod mirror;
