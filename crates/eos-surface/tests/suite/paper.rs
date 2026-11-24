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

/// The paper's design body, put together from its files.
pub(crate) fn body() -> Value {
    serde_json::json!({
        "template": file("template.html"),
        "style": file("style.css"),
        "contract": json("contract.json"),
        "uses": ["surface.feedback"],
        "sample": json("sample.json"),
    })
}

pub(crate) fn design() -> eos_surface::PageDesign {
    eos_surface::PageDesign::from_body(&body()).expect("the paper's design passes its static checks")
}

/// Compares `actual` with the stored output `golden/<name>`; with
/// `EOS_UPDATE_GOLDEN=1` writes it instead.
pub(crate) fn golden(name: &str, actual: &str) {
    let path = format!("{DIR}/golden/{name}");
    if std::env::var_os("EOS_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(format!("{DIR}/golden")).expect("golden folder");
        std::fs::write(&path, actual).expect("writes the golden output");
        return;
    }
    let expected =
        std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{path} is missing: run with EOS_UPDATE_GOLDEN=1"));
    assert!(
        expected == actual,
        "{name} differs from its stored output; run with EOS_UPDATE_GOLDEN=1 and review the diff"
    );
}
