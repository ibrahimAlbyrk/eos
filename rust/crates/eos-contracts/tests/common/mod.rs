//! Every wire type behind its Zod schema name, for the data-driven tests.

#![allow(clippy::wildcard_imports, dead_code)]

use eos_contracts::*;
use serde_json::Value;

macro_rules! dispatch {
    ($($name:literal => $ty:ty,)*) => {
        /// The schema names `run` knows.
        pub(crate) const SCHEMAS: &[&str] = &[$($name),*];

        /// `schema.safeParse(input)` on the Rust side: parse, validate, write back.
        pub(crate) fn run(schema: &str, input: &Value) -> Option<Result<Value, ValidationError>> {
            match schema {
                $($name => Some(parse::<$ty>(input).map(|v| serde_json::to_value(v).expect("serializes"))),)*
                _ => None,
            }
        }

        /// Read and write back without the request checks: for bodies the daemon produced.
        pub(crate) fn decode(schema: &str, input: &Value) -> Option<Result<Value, ValidationError>> {
            match schema {
                $($name => Some(read::<$ty>(input).map(|v| serde_json::to_value(v).expect("serializes"))),)*
                _ => None,
            }
        }
    };
}
include!("../vectors/dispatch.rs");
