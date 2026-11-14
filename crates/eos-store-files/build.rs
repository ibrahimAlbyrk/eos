//! Lists the prompt library (`assets/prompts/**/*.prompt.md`) for embedding,
//! in the order the library is walked: each folder's entries by name, a
//! folder's files where the folder stands.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir).expect("the prompts folder").flatten().collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else if path.to_string_lossy().ends_with(".prompt.md") {
            out.push(path);
        }
    }
}

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("the manifest folder")).join("assets/prompts");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    walk(&root, &mut files);

    let mut table = String::from("&[\n");
    for file in &files {
        let relative = file.strip_prefix(&root).expect("under the root");
        let name: Vec<_> = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect();
        let _ = writeln!(table, "    ({:?}, include_str!({:?})),", name.join("/"), file.display().to_string());
    }
    table.push_str("]\n");
    let out = PathBuf::from(env::var("OUT_DIR").expect("the output folder")).join("prompts_table.rs");
    fs::write(out, table).expect("the table");
}
