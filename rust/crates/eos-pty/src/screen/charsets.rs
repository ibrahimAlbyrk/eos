//! The national and line-drawing character sets a program can map ASCII to
//! (`common/data/Charsets.ts`). Only the first character of a replacement is
//! used, as xterm does.

pub(super) type Charset = &'static [(u8, char)];

const DEC_SPECIAL: Charset = &[
    (b'`', '\u{25c6}'),
    (b'a', '\u{2592}'),
    (b'b', '\u{2409}'),
    (b'c', '\u{240c}'),
    (b'd', '\u{240d}'),
    (b'e', '\u{240a}'),
    (b'f', '\u{00b0}'),
    (b'g', '\u{00b1}'),
    (b'h', '\u{2424}'),
    (b'i', '\u{240b}'),
    (b'j', '\u{2518}'),
    (b'k', '\u{2510}'),
    (b'l', '\u{250c}'),
    (b'm', '\u{2514}'),
    (b'n', '\u{253c}'),
    (b'o', '\u{23ba}'),
    (b'p', '\u{23bb}'),
    (b'q', '\u{2500}'),
    (b'r', '\u{23bc}'),
    (b's', '\u{23bd}'),
    (b't', '\u{251c}'),
    (b'u', '\u{2524}'),
    (b'v', '\u{2534}'),
    (b'w', '\u{252c}'),
    (b'x', '\u{2502}'),
    (b'y', '\u{2264}'),
    (b'z', '\u{2265}'),
    (b'{', '\u{03c0}'),
    (b'|', '\u{2260}'),
    (b'}', '\u{00a3}'),
    (b'~', '\u{00b7}'),
];
const BRITISH: Charset = &[(b'#', '£')];
const DUTCH: Charset = &[
    (b'#', '£'),
    (b'@', '¾'),
    (b'[', 'i'),
    (b'\\', '½'),
    (b']', '|'),
    (b'{', '¨'),
    (b'|', 'f'),
    (b'}', '¼'),
    (b'~', '´'),
];
const FINNISH: Charset = &[
    (b'[', 'Ä'),
    (b'\\', 'Ö'),
    (b']', 'Å'),
    (b'^', 'Ü'),
    (b'`', 'é'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'å'),
    (b'~', 'ü'),
];
const FRENCH: Charset = &[
    (b'#', '£'),
    (b'@', 'à'),
    (b'[', '°'),
    (b'\\', 'ç'),
    (b']', '§'),
    (b'{', 'é'),
    (b'|', 'ù'),
    (b'}', 'è'),
    (b'~', '¨'),
];
const FRENCH_CANADIAN: Charset = &[
    (b'@', 'à'),
    (b'[', 'â'),
    (b'\\', 'ç'),
    (b']', 'ê'),
    (b'^', 'î'),
    (b'`', 'ô'),
    (b'{', 'é'),
    (b'|', 'ù'),
    (b'}', 'è'),
    (b'~', 'û'),
];
const GERMAN: Charset =
    &[(b'@', '§'), (b'[', 'Ä'), (b'\\', 'Ö'), (b']', 'Ü'), (b'{', 'ä'), (b'|', 'ö'), (b'}', 'ü'), (b'~', 'ß')];
const ITALIAN: Charset = &[
    (b'#', '£'),
    (b'@', '§'),
    (b'[', '°'),
    (b'\\', 'ç'),
    (b']', 'é'),
    (b'`', 'ù'),
    (b'{', 'à'),
    (b'|', 'ò'),
    (b'}', 'è'),
    (b'~', 'ì'),
];
const NORWEGIAN: Charset = &[
    (b'@', 'Ä'),
    (b'[', 'Æ'),
    (b'\\', 'Ø'),
    (b']', 'Å'),
    (b'^', 'Ü'),
    (b'`', 'ä'),
    (b'{', 'æ'),
    (b'|', 'ø'),
    (b'}', 'å'),
    (b'~', 'ü'),
];
const SPANISH: Charset =
    &[(b'#', '£'), (b'@', '§'), (b'[', '¡'), (b'\\', 'Ñ'), (b']', '¿'), (b'{', '°'), (b'|', 'ñ'), (b'}', 'ç')];
const SWEDISH: Charset = &[
    (b'@', 'É'),
    (b'[', 'Ä'),
    (b'\\', 'Ö'),
    (b']', 'Å'),
    (b'^', 'Ü'),
    (b'`', 'é'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'å'),
    (b'~', 'ü'),
];
const SWISS: Charset = &[
    (b'#', 'ù'),
    (b'@', 'à'),
    (b'[', 'é'),
    (b'\\', 'ç'),
    (b']', 'ê'),
    (b'^', 'î'),
    (b'_', 'è'),
    (b'`', 'ô'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'ü'),
    (b'~', 'û'),
];

/// The set a designator names. The outer `None`: not a designator the
/// terminal knows; the inner `None`: plain ASCII (`B`).
pub(super) fn by_flag(flag: u8) -> Option<Option<Charset>> {
    Some(match flag {
        b'0' => Some(DEC_SPECIAL),
        b'A' => Some(BRITISH),
        b'B' => None,
        b'4' => Some(DUTCH),
        b'C' | b'5' => Some(FINNISH),
        b'R' => Some(FRENCH),
        b'Q' => Some(FRENCH_CANADIAN),
        b'K' => Some(GERMAN),
        b'Y' => Some(ITALIAN),
        b'E' | b'6' => Some(NORWEGIAN),
        b'Z' => Some(SPANISH),
        b'H' | b'7' => Some(SWEDISH),
        b'=' => Some(SWISS),
        _ => return None,
    })
}

pub(super) fn translate(charset: Charset, code: u32) -> u32 {
    charset.iter().find(|(from, _)| u32::from(*from) == code).map_or(code, |(_, to)| u32::from(*to))
}

/// G0–G3 and which one is in use.
#[derive(Debug, Clone, Default)]
pub(super) struct Charsets {
    /// The set printing goes through. Restoring a saved cursor sets it
    /// without touching the slots, as xterm does.
    pub(super) active: Option<Charset>,
    level: usize,
    slots: [Option<Charset>; 4],
}

impl Charsets {
    pub(super) fn set_level(&mut self, level: usize) {
        self.level = level;
        self.active = self.slots.get(level).copied().flatten();
    }

    pub(super) fn set_slot(&mut self, slot: usize, charset: Option<Charset>) {
        if let Some(entry) = self.slots.get_mut(slot) {
            *entry = charset;
        }
        if self.level == slot {
            self.active = charset;
        }
    }
}
