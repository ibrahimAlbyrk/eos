//! Writes a Chromium `Local Storage/leveldb` folder from a JSON object of strings, as the
//! Electron app would have left it. For trying the storage carry-over on prepared data:
//!
//!   seed_local_storage <profile dir> <keys.json> [origin, default eos://app]
//!
//! The store lands in `<profile dir>/Local Storage/leveldb`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use eos_bridge::migrate::{ELECTRON_ORIGIN, write_local_storage};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(profile), Some(json)) = (args.first(), args.get(1)) else {
        eprintln!("usage: seed_local_storage <profile dir> <keys.json> [origin]");
        std::process::exit(2);
    };
    let origin = args.get(2).map_or(ELECTRON_ORIGIN, String::as_str);
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(json)?)?;
    let keys: BTreeMap<String, String> = value
        .as_object()
        .ok_or("the file must hold a JSON object")?
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string)))
        .collect();
    let store = PathBuf::from(profile).join("Local Storage").join("leveldb");
    std::fs::create_dir_all(&store)?;
    write_local_storage(&store, origin, &keys)?;
    println!("{} keys for {origin}", keys.len());
    Ok(())
}
