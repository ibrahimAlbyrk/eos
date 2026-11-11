//! Symbols by name, from the syntax alone: go to definition, find
//! references, symbol search and a file's outline, behind the core's
//! `SymbolIndex` port.
//!
//! Files are parsed with tree-sitter and each language's tag query
//! (`queries/`). Two symbols of one name in different files both match:
//! nothing here resolves bindings.
//!
//! - One index per project root, built on first use from the project's
//!   candidate files (the list file search uses), kept in memory.
//! - Vendored code, minified files and files over 512 KiB stay out.
//! - At most [`MAX_RESIDENT_ROOTS`] projects are kept; the least recently
//!   used one goes first. An index holds no source text: the line shown with
//!   a result is read from disk when the result is returned.
//! - Parsing runs off the async threads, one request at a time.

mod index;
mod languages;
mod parse;

pub use index::{MAX_RESIDENT_ROOTS, TagIndex};
