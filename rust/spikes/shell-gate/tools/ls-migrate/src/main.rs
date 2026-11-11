// Reads a Chromium "Local Storage/leveldb" directory (a COPY of the Electron profile's)
// and writes the keys of one origin as a JSON object, ready to seed the new origin.
//
//   ls-migrate <leveldb dir> <origin> <out.json>      e.g. origin = eos://app
//
// Chromium's layout: `_<storage key>\0<key>` → value, where key and value start with one
// encoding byte: 0 = UTF-16LE, 1 = Latin-1. `META:<storage key>` rows hold bookkeeping.
use rusty_leveldb::{DB, LdbIterator, Options};

fn decode(bytes: &[u8]) -> Option<String> {
  match bytes.split_first()? {
    (0, rest) => {
      let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
      String::from_utf16(&units).ok()
    }
    (1, rest) => Some(rest.iter().map(|b| *b as char).collect()),
    _ => None,
  }
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  if args.len() != 4 {
    eprintln!("usage: ls-migrate <leveldb dir> <origin> <out.json>");
    std::process::exit(2);
  }
  let mut options = Options::default();
  options.create_if_missing = false;
  let mut db = DB::open(&args[1], options).expect("open leveldb (use a copy of the profile)");
  let prefix = format!("_{}\0", args[2]).into_bytes();
  let mut out = serde_json::Map::new();
  let (mut origins, mut skipped, mut bytes) = (std::collections::BTreeSet::new(), 0usize, 0usize);
  let mut it = db.new_iter().expect("iterator");
  while let Some((key, value)) = it.next() {
    if let Some(rest) = key.strip_prefix(b"META:") {
      origins.insert(String::from_utf8_lossy(rest).into_owned());
    }
    let Some(raw_key) = key.strip_prefix(prefix.as_slice()) else { continue };
    match (decode(raw_key), decode(&value)) {
      (Some(k), Some(v)) => {
        bytes += k.len() + v.len();
        out.insert(k, serde_json::Value::String(v));
      }
      _ => skipped += 1,
    }
  }
  // Key names and sizes only: the values are the user's data.
  eprintln!("origins in this store: {origins:?}");
  eprintln!("{}: {} keys, {} bytes, {} undecodable", args[2], out.len(), bytes, skipped);
  std::fs::write(&args[3], serde_json::Value::Object(out).to_string()).expect("write out.json");
}
