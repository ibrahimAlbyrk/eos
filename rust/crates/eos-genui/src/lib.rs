//! Visual answers (generative UI): what an agent's `present` call must look like
//! and how it is read.
//!
//! The dashboard keeps its JavaScript parsers; this crate is the same behaviour
//! for the core: the same accept/reject decision, the same problem paths and
//! messages (agents read them), the same parsed structure and the same catalog
//! prompt, byte for byte. `rust/fixtures/genui` holds the vectors both are held
//! to (`tests/corpus.rs`); `rust/tools/genui-vectors` regenerates them from the
//! TypeScript in `contracts/src/genui`, and the tests fail when they are stale.
//!
//! Where "the same" is not the obvious thing, the TypeScript wins:
//! - lengths, offsets, lines and columns count UTF-16 code units;
//! - half a surrogate pair (a 40-character cut through an emoji) reads as U+FFFD,
//!   which is what Node writes for it — except where the TypeScript runs the text
//!   through `JSON.stringify`, which prints `\ud83d`;
//! - object keys are walked in JavaScript property order (index-like keys first),
//!   since problem lists follow that order ([`Value`], [`Object`]);
//! - the entity and action schemas raise Zod's issues in Zod's order, including
//!   what a union reports;
//! - a markup attribute or action field named like a member every JavaScript
//!   object inherits (`constructor`, `toString`, …) is not reported as unknown, and
//!   a `__proto__` key in an action's `set` does not count as a key;
//! - a Carousel's `limit=` is read with `Number()`, so `"0x8"` limits to 8 and
//!   `"2.5"` yields "2.5 items".
//!
//! Three things are deliberately not the TypeScript's:
//! - text functions take `&str`, so "must be a string" results cannot occur;
//! - filters compare case-insensitively without a locale (the TypeScript uses the
//!   process locale, so a Turkish system lower-cases `I` to `ı`);
//! - nothing recurses over the nesting of a document: a view nested thousands of
//!   levels deep is rejected with problems, where the TypeScript runs out of stack.

mod js;
mod re;
mod utf16;

pub mod attrs;
pub mod catalog;
pub mod expr;
pub mod markup;
pub mod partial_json;
pub mod prompt;
pub mod spec;
pub mod value;
pub mod wire;

pub use catalog::{ViewProblem, ViewStats, ViewValidation, format_problems, validate_view};
pub use prompt::catalog_prompt;
pub use spec::{AppValidation, Error, ViewId, validate_app};
pub use value::{Object, Value};
