//! How many cells a character takes, by xterm.js's Unicode 6 table
//! (`common/input/UnicodeV6.ts`) — the one a headless xterm uses, and so the
//! one the snapshots were always made with. Emoji are one cell wide here.

const BMP_COMBINING: &[(u32, u32)] = &[
    (0x0300, 0x036F),
    (0x0483, 0x0486),
    (0x0488, 0x0489),
    (0x0591, 0x05BD),
    (0x05BF, 0x05BF),
    (0x05C1, 0x05C2),
    (0x05C4, 0x05C5),
    (0x05C7, 0x05C7),
    (0x0600, 0x0603),
    (0x0610, 0x0615),
    (0x064B, 0x065E),
    (0x0670, 0x0670),
    (0x06D6, 0x06E4),
    (0x06E7, 0x06E8),
    (0x06EA, 0x06ED),
    (0x070F, 0x070F),
    (0x0711, 0x0711),
    (0x0730, 0x074A),
    (0x07A6, 0x07B0),
    (0x07EB, 0x07F3),
    (0x0901, 0x0902),
    (0x093C, 0x093C),
    (0x0941, 0x0948),
    (0x094D, 0x094D),
    (0x0951, 0x0954),
    (0x0962, 0x0963),
    (0x0981, 0x0981),
    (0x09BC, 0x09BC),
    (0x09C1, 0x09C4),
    (0x09CD, 0x09CD),
    (0x09E2, 0x09E3),
    (0x0A01, 0x0A02),
    (0x0A3C, 0x0A3C),
    (0x0A41, 0x0A42),
    (0x0A47, 0x0A48),
    (0x0A4B, 0x0A4D),
    (0x0A70, 0x0A71),
    (0x0A81, 0x0A82),
    (0x0ABC, 0x0ABC),
    (0x0AC1, 0x0AC5),
    (0x0AC7, 0x0AC8),
    (0x0ACD, 0x0ACD),
    (0x0AE2, 0x0AE3),
    (0x0B01, 0x0B01),
    (0x0B3C, 0x0B3C),
    (0x0B3F, 0x0B3F),
    (0x0B41, 0x0B43),
    (0x0B4D, 0x0B4D),
    (0x0B56, 0x0B56),
    (0x0B82, 0x0B82),
    (0x0BC0, 0x0BC0),
    (0x0BCD, 0x0BCD),
    (0x0C3E, 0x0C40),
    (0x0C46, 0x0C48),
    (0x0C4A, 0x0C4D),
    (0x0C55, 0x0C56),
    (0x0CBC, 0x0CBC),
    (0x0CBF, 0x0CBF),
    (0x0CC6, 0x0CC6),
    (0x0CCC, 0x0CCD),
    (0x0CE2, 0x0CE3),
    (0x0D41, 0x0D43),
    (0x0D4D, 0x0D4D),
    (0x0DCA, 0x0DCA),
    (0x0DD2, 0x0DD4),
    (0x0DD6, 0x0DD6),
    (0x0E31, 0x0E31),
    (0x0E34, 0x0E3A),
    (0x0E47, 0x0E4E),
    (0x0EB1, 0x0EB1),
    (0x0EB4, 0x0EB9),
    (0x0EBB, 0x0EBC),
    (0x0EC8, 0x0ECD),
    (0x0F18, 0x0F19),
    (0x0F35, 0x0F35),
    (0x0F37, 0x0F37),
    (0x0F39, 0x0F39),
    (0x0F71, 0x0F7E),
    (0x0F80, 0x0F84),
    (0x0F86, 0x0F87),
    (0x0F90, 0x0F97),
    (0x0F99, 0x0FBC),
    (0x0FC6, 0x0FC6),
    (0x102D, 0x1030),
    (0x1032, 0x1032),
    (0x1036, 0x1037),
    (0x1039, 0x1039),
    (0x1058, 0x1059),
    (0x1160, 0x11FF),
    (0x135F, 0x135F),
    (0x1712, 0x1714),
    (0x1732, 0x1734),
    (0x1752, 0x1753),
    (0x1772, 0x1773),
    (0x17B4, 0x17B5),
    (0x17B7, 0x17BD),
    (0x17C6, 0x17C6),
    (0x17C9, 0x17D3),
    (0x17DD, 0x17DD),
    (0x180B, 0x180D),
    (0x18A9, 0x18A9),
    (0x1920, 0x1922),
    (0x1927, 0x1928),
    (0x1932, 0x1932),
    (0x1939, 0x193B),
    (0x1A17, 0x1A18),
    (0x1B00, 0x1B03),
    (0x1B34, 0x1B34),
    (0x1B36, 0x1B3A),
    (0x1B3C, 0x1B3C),
    (0x1B42, 0x1B42),
    (0x1B6B, 0x1B73),
    (0x1DC0, 0x1DCA),
    (0x1DFE, 0x1DFF),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2063),
    (0x206A, 0x206F),
    (0x20D0, 0x20EF),
    (0x302A, 0x302F),
    (0x3099, 0x309A),
    (0xA806, 0xA806),
    (0xA80B, 0xA80B),
    (0xA825, 0xA826),
    (0xFB1E, 0xFB1E),
    (0xFE00, 0xFE0F),
    (0xFE20, 0xFE23),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
];

const HIGH_COMBINING: &[(u32, u32)] = &[
    (0x10A01, 0x10A03),
    (0x10A05, 0x10A06),
    (0x10A0C, 0x10A0F),
    (0x10A38, 0x10A3A),
    (0x10A3F, 0x10A3F),
    (0x1D167, 0x1D169),
    (0x1D173, 0x1D182),
    (0x1D185, 0x1D18B),
    (0x1D1AA, 0x1D1AD),
    (0x1D242, 0x1D244),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
    (0xE0100, 0xE01EF),
];

/// Two cells wide in the basic plane (before the combining ranges take their share).
const BMP_WIDE: &[(u32, u32)] = &[
    (0x1100, 0x115F),
    (0x2329, 0x232A),
    (0x2E80, 0xA4CF),
    (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF),
    (0xFE10, 0xFE19),
    (0xFE30, 0xFE6F),
    (0xFF00, 0xFF60),
    (0xFFE0, 0xFFE6),
];

fn within(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if cp < lo {
                std::cmp::Ordering::Greater
            } else if cp > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// 0, 1 or 2 cells.
pub(super) fn wcwidth(cp: u32) -> u32 {
    if cp < 32 {
        return 0;
    }
    if cp < 127 {
        return 1;
    }
    if cp < 0x1_0000 {
        if cp < 0xA0 || within(BMP_COMBINING, cp) {
            return 0;
        }
        // U+303F sits in the wide block and is narrow.
        if cp != 0x303F && within(BMP_WIDE, cp) {
            return 2;
        }
        return 1;
    }
    if within(HIGH_COMBINING, cp) {
        return 0;
    }
    if (0x2_0000..=0x2_FFFD).contains(&cp) || (0x3_0000..=0x3_FFFD).contains(&cp) { 2 } else { 1 }
}

/// What the terminal remembers of the character before: `width << 1 | joined`.
pub(super) type CharProps = u32;

pub(super) fn props_width(props: CharProps) -> u32 {
    (props >> 1) & 3
}

pub(super) fn props_join(props: CharProps) -> bool {
    props & 1 != 0
}

/// A zero-width character joins the one before it, and the pair is as wide
/// as that one.
pub(super) fn char_props(cp: u32, preceding: CharProps) -> CharProps {
    let mut width = wcwidth(cp);
    let mut join = width == 0 && preceding != 0;
    if join {
        let old = props_width(preceding);
        if old == 0 {
            join = false;
        } else if old > width {
            width = old;
        }
    }
    ((width & 3) << 1) | u32::from(join)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_follow_the_unicode_6_table() {
        assert_eq!(wcwidth(u32::from('a')), 1);
        assert_eq!(wcwidth(0x7F), 0);
        assert_eq!(wcwidth(0x9F), 0);
        assert_eq!(wcwidth(u32::from('é')), 1);
        assert_eq!(wcwidth(u32::from('漢')), 2);
        assert_eq!(wcwidth(0x303F), 1);
        assert_eq!(wcwidth(0x0301), 0);
        assert_eq!(wcwidth(0x1160), 0, "combining wins over the wide block");
        assert_eq!(wcwidth(0x1F600), 1, "emoji are narrow in this table");
        assert_eq!(wcwidth(0x2_0000), 2);
        assert_eq!(wcwidth(0xE0100), 0);
    }

    #[test]
    fn a_mark_joins_what_precedes_it() {
        let e = char_props(u32::from('e'), 0);
        let mark = char_props(0x0301, e);
        assert!(props_join(mark));
        assert_eq!(props_width(mark), 1);
        assert!(!props_join(char_props(0x0301, 0)), "nothing to join at the start");
    }
}
