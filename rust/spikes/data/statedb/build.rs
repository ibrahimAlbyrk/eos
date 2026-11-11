//! Embeds migrations/NNN_name.sql in the order index.json lists them.
use std::{env, fs, path::Path};

fn main() {
    let dir = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let index = fs::read_to_string(dir.join("index.json")).unwrap();
    let mut out = String::from("pub const MIGRATIONS: &[Migration] = &[\n");
    // index.json is machine-written: one `"id": "…"` line per migration.
    for line in index.lines() {
        let Some(rest) = line.trim().strip_prefix("\"id\": \"") else { continue };
        let id = rest.trim_end_matches(',').trim_end_matches('"');
        let path = dir.join(format!("{id}.sql"));
        out.push_str(&format!(
            "    Migration {{ id: {id:?}, sql: include_str!({:?}) }},\n",
            path.display().to_string()
        ));
    }
    out.push_str("];\n");
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("migrations.rs"), out).unwrap();
}
