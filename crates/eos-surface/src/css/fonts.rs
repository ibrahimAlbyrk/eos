//! The faces a page may name. Eos ships four (all under the SIL Open Font
//! License, licences beside the files in `assets/fonts/`) and inlines only
//! those a page uses; the rest are the Mac's own. Mail drops web fonts, so
//! each family has a stack mail falls back to.

use base64::Engine;

/// A family a page may name, and the stack mail writes in its place.
#[derive(Debug)]
pub struct Family {
    pub name: &'static str,
    pub mail: &'static str,
    faces: &'static [Face],
}

#[derive(Debug)]
struct Face {
    file: &'static [u8],
    weight: &'static str,
    style: &'static str,
    range: &'static str,
}

const LATIN: &str = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT: &str = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

macro_rules! face {
    ($file:literal, $weight:literal, $style:literal, $range:expr) => {
        Face {
            file: include_bytes!(concat!("../../assets/fonts/", $file)),
            weight: $weight,
            style: $style,
            range: $range,
        }
    };
}

pub const FAMILIES: &[Family] = &[
    Family {
        name: "Fraunces",
        mail: "Georgia, 'Times New Roman', serif",
        faces: &[
            face!("fraunces-latin-wght-normal.woff2", "100 900", "normal", LATIN),
            face!("fraunces-latin-ext-wght-normal.woff2", "100 900", "normal", LATIN_EXT),
            face!("fraunces-latin-wght-italic.woff2", "100 900", "italic", LATIN),
            face!("fraunces-latin-ext-wght-italic.woff2", "100 900", "italic", LATIN_EXT),
        ],
    },
    Family {
        name: "Source Serif 4",
        mail: "Georgia, 'Times New Roman', serif",
        faces: &[
            face!("source-serif-4-latin-wght-normal.woff2", "200 900", "normal", LATIN),
            face!("source-serif-4-latin-ext-wght-normal.woff2", "200 900", "normal", LATIN_EXT),
            face!("source-serif-4-latin-wght-italic.woff2", "200 900", "italic", LATIN),
            face!("source-serif-4-latin-ext-wght-italic.woff2", "200 900", "italic", LATIN_EXT),
        ],
    },
    Family {
        name: "Geist",
        mail: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
        faces: &[
            face!("geist-latin-wght-normal.woff2", "100 900", "normal", LATIN),
            face!("geist-latin-ext-wght-normal.woff2", "100 900", "normal", LATIN_EXT),
            face!("geist-latin-wght-italic.woff2", "100 900", "italic", LATIN),
            face!("geist-latin-ext-wght-italic.woff2", "100 900", "italic", LATIN_EXT),
        ],
    },
    Family {
        name: "IBM Plex Mono",
        mail: "Menlo, Consolas, 'Courier New', monospace",
        faces: &[
            face!("ibm-plex-mono-latin-400-normal.woff2", "400", "normal", LATIN),
            face!("ibm-plex-mono-latin-ext-400-normal.woff2", "400", "normal", LATIN_EXT),
            face!("ibm-plex-mono-latin-500-normal.woff2", "500", "normal", LATIN),
            face!("ibm-plex-mono-latin-ext-500-normal.woff2", "500", "normal", LATIN_EXT),
        ],
    },
];

/// Families on every Mac and in every mail client, which need no file.
pub const SYSTEM: &[&str] = &[
    "Georgia",
    "Times New Roman",
    "Helvetica",
    "Arial",
    "Menlo",
    "-apple-system",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "system-ui",
    "serif",
    "sans-serif",
    "monospace",
];

/// The family a page names, in Eos's own spelling, if a page may name it.
pub(crate) fn known(name: &str) -> Option<&'static str> {
    FAMILIES.iter().map(|f| f.name).chain(SYSTEM.iter().copied()).find(|known| known.eq_ignore_ascii_case(name))
}

pub(crate) fn shipped(name: &str) -> Option<&'static Family> {
    FAMILIES.iter().find(|f| f.name == name)
}

/// `@font-face` rules with the files inlined, for the shipped families named.
pub fn font_faces(families: &[&str]) -> String {
    let mut out = String::new();
    for family in FAMILIES.iter().filter(|f| families.contains(&f.name)) {
        for face in family.faces {
            let data = base64::engine::general_purpose::STANDARD.encode(face.file);
            out.push_str(&format!(
                "@font-face{{font-family:'{}';font-style:{};font-weight:{};font-display:block;src:url(data:font/woff2;base64,{data}) format('woff2');unicode-range:{}}}\n",
                family.name, face.style, face.weight, face.range
            ));
        }
    }
    out
}
