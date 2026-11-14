//! A cell's attributes, in xterm.js's bit layout (`common/buffer/Constants.ts`,
//! `AttributeData.ts`): the serializer's choices depend on the exact words
//! (`fg == 0 && bg == 0` is "default"), so the layout is kept, not remodelled.

pub(super) const CM_MASK: u32 = 0x0300_0000;
pub(super) const CM_P16: u32 = 0x0100_0000;
pub(super) const CM_P256: u32 = 0x0200_0000;
pub(super) const CM_RGB: u32 = 0x0300_0000;
pub(super) const RGB_MASK: u32 = 0x00FF_FFFF;
pub(super) const PCOLOR_MASK: u32 = 0xFF;

pub(super) const FG_INVERSE: u32 = 0x0400_0000;
pub(super) const FG_BOLD: u32 = 0x0800_0000;
pub(super) const FG_UNDERLINE: u32 = 0x1000_0000;
pub(super) const FG_BLINK: u32 = 0x2000_0000;
pub(super) const FG_INVISIBLE: u32 = 0x4000_0000;
pub(super) const FG_STRIKETHROUGH: u32 = 0x8000_0000;

pub(super) const BG_ITALIC: u32 = 0x0400_0000;
pub(super) const BG_DIM: u32 = 0x0800_0000;
pub(super) const BG_HAS_EXTENDED: u32 = 0x1000_0000;
pub(super) const BG_PROTECTED: u32 = 0x2000_0000;
pub(super) const BG_OVERLINE: u32 = 0x4000_0000;

const EXT_UNDERLINE_STYLE: u32 = 0x1C00_0000;
/// Not an xterm bit: the cell is inside a hyperlink (xterm keeps a link id
/// beside the word; only "is there one" ever reaches the serializer).
const EXT_LINK: u32 = 0x8000_0000;

/// The attributes that do not fit `fg` / `bg`: underline style and colour,
/// and whether the cell belongs to a link. They count only while the cell's
/// `bg` has [`BG_HAS_EXTENDED`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Ext(u32);

impl Ext {
    pub(super) const NONE: Ext = Ext(0);

    /// A link draws dashed, whatever style was set.
    pub(super) fn underline_style(self) -> u32 {
        if self.link() { 5 } else { (self.0 & EXT_UNDERLINE_STYLE) >> 26 }
    }

    pub(super) fn set_underline_style(&mut self, style: u32) {
        self.0 = (self.0 & !EXT_UNDERLINE_STYLE) | ((style << 26) & EXT_UNDERLINE_STYLE);
    }

    pub(super) fn underline_color(self) -> u32 {
        self.0 & (CM_MASK | RGB_MASK)
    }

    pub(super) fn set_underline_color(&mut self, color: u32) {
        self.0 = (self.0 & !(CM_MASK | RGB_MASK)) | (color & (CM_MASK | RGB_MASK));
    }

    pub(super) fn link(self) -> bool {
        self.0 & EXT_LINK != 0
    }

    pub(super) fn set_link(&mut self, on: bool) {
        self.0 = if on { self.0 | EXT_LINK } else { self.0 & !EXT_LINK };
    }

    pub(super) fn is_empty(self) -> bool {
        self.underline_style() == 0 && !self.link()
    }
}

/// `fg`, `bg` and the extended word: the pen, and every cell's style.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Attr {
    pub(super) fg: u32,
    pub(super) bg: u32,
    pub(super) ext: Ext,
}

impl Attr {
    pub(super) fn is_inverse(&self) -> bool {
        self.fg & FG_INVERSE != 0
    }
    pub(super) fn is_bold(&self) -> bool {
        self.fg & FG_BOLD != 0
    }
    /// Non-zero when underlined. Two underlined cells can still read
    /// differently — `1` through the extended word, the flag's bit otherwise —
    /// and xterm's serializer compares these numbers, so they are kept apart.
    pub(super) fn underline(&self) -> u32 {
        if self.bg & BG_HAS_EXTENDED != 0 && self.ext.underline_style() != 0 { 1 } else { self.fg & FG_UNDERLINE }
    }
    pub(super) fn is_blink(&self) -> bool {
        self.fg & FG_BLINK != 0
    }
    pub(super) fn is_invisible(&self) -> bool {
        self.fg & FG_INVISIBLE != 0
    }
    pub(super) fn is_italic(&self) -> bool {
        self.bg & BG_ITALIC != 0
    }
    pub(super) fn is_dim(&self) -> bool {
        self.bg & BG_DIM != 0
    }
    pub(super) fn is_strikethrough(&self) -> bool {
        self.fg & FG_STRIKETHROUGH != 0
    }
    pub(super) fn is_overline(&self) -> bool {
        self.bg & BG_OVERLINE != 0
    }

    pub(super) fn fg_mode(&self) -> u32 {
        self.fg & CM_MASK
    }
    pub(super) fn bg_mode(&self) -> u32 {
        self.bg & CM_MASK
    }

    /// The colour value under the mode; `None` is xterm's `-1` (default colour).
    pub(super) fn fg_color(&self) -> Option<u32> {
        color_of(self.fg)
    }
    pub(super) fn bg_color(&self) -> Option<u32> {
        color_of(self.bg)
    }

    pub(super) fn is_default(&self) -> bool {
        self.fg == 0 && self.bg == 0
    }

    /// Sets or clears [`BG_HAS_EXTENDED`] to match the extended word.
    pub(super) fn update_extended(&mut self) {
        if self.ext.is_empty() {
            self.bg &= !BG_HAS_EXTENDED;
        } else {
            self.bg |= BG_HAS_EXTENDED;
        }
    }
}

fn color_of(word: u32) -> Option<u32> {
    match word & CM_MASK {
        CM_P16 | CM_P256 => Some(word & PCOLOR_MASK),
        CM_RGB => Some(word & RGB_MASK),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_reads_as_a_dashed_underline_and_keeps_the_extended_flag() {
        let mut attr = Attr::default();
        attr.ext.set_link(true);
        attr.update_extended();
        assert!(attr.bg & BG_HAS_EXTENDED != 0);
        assert!(attr.underline() != 0);
        assert!(!attr.is_default());
        attr.ext.set_link(false);
        attr.update_extended();
        assert!(attr.is_default());
    }

    #[test]
    fn underline_colour_alone_is_not_an_extended_attribute() {
        let mut attr = Attr::default();
        attr.ext.set_underline_color(CM_P256 | 196);
        attr.update_extended();
        assert!(attr.is_default());
        attr.ext.set_underline_style(3);
        attr.update_extended();
        assert!(attr.underline() != 0);
        assert_eq!(attr.ext.underline_color(), CM_P256 | 196);
    }
}
