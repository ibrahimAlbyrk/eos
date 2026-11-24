//! The morning paper fixture every page test reads.

use eos_surface::Contract;
use serde_json::Value;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/morning-paper");

pub(crate) fn file(name: &str) -> String {
    std::fs::read_to_string(format!("{DIR}/{name}")).expect("the fixture file is there")
}

pub(crate) fn json(name: &str) -> Value {
    serde_json::from_str(&file(name)).expect("the fixture file is JSON")
}

pub(crate) fn contract() -> Contract {
    Contract::parse(&json("contract.json")).expect("the paper's contract is valid")
}
