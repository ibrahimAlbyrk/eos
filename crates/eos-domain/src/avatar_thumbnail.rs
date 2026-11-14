//! The avatar drawn small: which sizes a thumbnail comes in, how large one is, and the
//! pixel size of the stored image, read from its own header.

use eos_contracts::AvatarExt;

use crate::user_profile::sniff_avatar_ext;

/// The sizes a thumbnail is made in, in device pixels. A request gets the smallest one at
/// least as large, so an avatar never has more thumbnails than this.
pub const AVATAR_THUMBNAIL_SIZES: [u32; 6] = [32, 48, 64, 96, 128, 256];

/// The thumbnail size that serves a request for `asked` device pixels.
pub fn avatar_thumbnail_size(asked: u32) -> u32 {
    AVATAR_THUMBNAIL_SIZES.iter().copied().find(|size| *size >= asked).unwrap_or(256)
}

/// Width and height of the thumbnail of a `width`×`height` image: the shorter side becomes
/// `size` and the aspect is kept (the dashboard draws it with `object-fit: cover`). `None`
/// when the image is not larger than that.
pub fn avatar_thumbnail_dims(width: u32, height: u32, size: u32) -> Option<(u32, u32)> {
    let short = u64::from(width.min(height));
    if short <= u64::from(size) {
        return None;
    }
    let scaled = |side: u32| {
        let side = (u64::from(side) * u64::from(size) + short / 2) / short;
        u32::try_from(side).unwrap_or(u32::MAX).max(1)
    };
    Some((scaled(width), scaled(height)))
}

/// Width and height of a PNG, JPEG or WebP image that is drawn as it is stored. `None`
/// for a header this cannot read, or for an image whose metadata turns or mirrors it when
/// drawn (EXIF orientation): a scaled copy would lose that.
pub fn upright_image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    match sniff_avatar_ext(bytes)? {
        AvatarExt::Png => png_size(bytes),
        AvatarExt::Jpeg => jpeg_size(bytes),
        AvatarExt::Webp => webp_size(bytes),
    }
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
}

/// IHDR, then the chunks before the image data: an `eXIf` chunk may turn it.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let size = (be32(bytes, 16)?, be32(bytes, 20)?);
    let mut at = 8usize;
    loop {
        let len = usize::try_from(be32(bytes, at)?).ok()?;
        match bytes.get(at + 4..at + 8)? {
            b"IDAT" => return Some(size),
            b"eXIf" => return None,
            _ => at = at.checked_add(12)?.checked_add(len)?,
        }
    }
}

/// The frame header's size, unless an EXIF orientation other than "as stored" comes first.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2usize;
    loop {
        if *bytes.get(at)? != 0xff {
            return None;
        }
        let marker = *bytes.get(at + 1)?;
        match marker {
            0xff => at += 1,
            0x01 | 0xd0..=0xd8 => at += 2,
            // The scan or the end before any frame header.
            0xd9 | 0xda => return None,
            _ => {
                let len = usize::try_from(be16(bytes, at + 2)?).ok()?;
                let segment = bytes.get(at + 4..at + 2 + len.max(2))?;
                if marker == 0xe1
                    && let Some(tiff) = segment.strip_prefix(b"Exif\0\0")
                    && exif_orientation(tiff).is_some_and(|o| o != 1)
                {
                    return None;
                }
                if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                    return Some((be16(segment, 3)?, be16(segment, 1)?));
                }
                at += 2 + len;
            }
        }
    }
}

/// Tag 0x0112 of the first image directory of an EXIF block.
fn exif_orientation(tiff: &[u8]) -> Option<u32> {
    let little = match tiff.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u32> {
        let b: [u8; 2] = tiff.get(at..at + 2)?.try_into().ok()?;
        Some(u32::from(if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }))
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(at..at + 4)?.try_into().ok()?;
        Some(if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };
    let dir = usize::try_from(u32_at(4)?).ok()?;
    let entries = usize::try_from(u16_at(dir)?).ok()?;
    (0..entries).map(|i| dir + 2 + i * 12).find(|at| u16_at(*at) == Some(0x0112)).and_then(|at| u16_at(at + 8))
}

/// The lossy, lossless or extended header. An extended one that carries EXIF may turn it.
fn webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    match bytes.get(12..16)? {
        b"VP8 " => {
            if bytes.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let w = u32::from(u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?)) & 0x3fff;
            let h = u32::from(u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?)) & 0x3fff;
            Some((w, h))
        }
        b"VP8L" => {
            if *bytes.get(20)? != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8X" => {
            const HAS_EXIF: u8 = 0x08;
            if bytes.get(20)? & HAS_EXIF != 0 {
                return None;
            }
            Some((le24(bytes, 24)? + 1, le24(bytes, 27)? + 1))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32, extra: &[u8]) -> Vec<u8> {
        let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(extra);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(b"IDAT");
        out
    }

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(data.len()).unwrap_or(0).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    fn exif(orientation: u16, little: bool) -> Vec<u8> {
        let w16 = |v: u16| if little { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if little { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut tiff = if little { b"II".to_vec() } else { b"MM".to_vec() };
        tiff.extend_from_slice(&w16(42));
        tiff.extend_from_slice(&w32(8));
        tiff.extend_from_slice(&w16(2));
        for (tag, value) in [(0x010f, 7), (0x0112, orientation)] {
            tiff.extend_from_slice(&w16(tag));
            tiff.extend_from_slice(&w16(3));
            tiff.extend_from_slice(&w32(1));
            tiff.extend_from_slice(&w16(value));
            tiff.extend_from_slice(&[0, 0]);
        }
        let mut segment = b"Exif\0\0".to_vec();
        segment.extend_from_slice(&tiff);
        segment
    }

    fn jpeg(width: u16, height: u16, app1: Option<Vec<u8>>) -> Vec<u8> {
        let mut out = vec![0xff, 0xd8, 0xff, 0xe0, 0, 16];
        out.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        if let Some(body) = app1 {
            out.extend_from_slice(&[0xff, 0xe1]);
            out.extend_from_slice(&u16::try_from(body.len() + 2).unwrap_or(0).to_be_bytes());
            out.extend_from_slice(&body);
        }
        out.extend_from_slice(&[0xff, 0xff, 0xc2, 0, 17, 8]);
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        out.extend_from_slice(&[0xff, 0xda]);
        out
    }

    fn webp(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBP".to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn a_request_gets_the_next_size_up_and_never_more_than_the_largest() {
        assert_eq!(
            [1, 32, 33, 48, 80, 108, 128, 129, 5000].map(avatar_thumbnail_size),
            [32, 32, 48, 48, 96, 128, 128, 256, 256]
        );
    }

    #[test]
    fn the_shorter_side_becomes_the_size_and_the_aspect_stays() {
        assert_eq!(avatar_thumbnail_dims(1024, 1536, 48), Some((48, 72)));
        assert_eq!(avatar_thumbnail_dims(1536, 1024, 48), Some((72, 48)));
        assert_eq!(avatar_thumbnail_dims(1000, 1000, 96), Some((96, 96)));
        assert_eq!(avatar_thumbnail_dims(64, 4000, 48), Some((48, 3000)));
        // Never larger than it is.
        assert_eq!(avatar_thumbnail_dims(48, 4000, 48), None);
        assert_eq!(avatar_thumbnail_dims(0, 10, 48), None);
    }

    #[test]
    fn png_sizes_come_from_the_header_unless_it_may_be_turned() {
        assert_eq!(upright_image_size(&png(1024, 1536, &[])), Some((1024, 1536)));
        assert_eq!(upright_image_size(&png(3, 2, &chunk(b"tEXt", b"k\0v"))), Some((3, 2)));
        assert_eq!(upright_image_size(&png(3, 2, &chunk(b"eXIf", &exif(6, false)[6..]))), None);
        assert_eq!(upright_image_size(&png(3, 2, &[])[..20]), None, "cut short");
    }

    #[test]
    fn jpeg_sizes_come_from_the_frame_header_unless_exif_turns_it() {
        assert_eq!(upright_image_size(&jpeg(300, 200, None)), Some((300, 200)));
        assert_eq!(upright_image_size(&jpeg(300, 200, Some(exif(1, false)))), Some((300, 200)));
        assert_eq!(upright_image_size(&jpeg(300, 200, Some(exif(1, true)))), Some((300, 200)));
        for turned in [2, 3, 6, 8] {
            assert_eq!(upright_image_size(&jpeg(300, 200, Some(exif(turned, true)))), None, "{turned}");
            assert_eq!(upright_image_size(&jpeg(300, 200, Some(exif(turned, false)))), None, "{turned}");
        }
        assert_eq!(upright_image_size(&jpeg(300, 200, None)[..30]), None, "cut short");
        assert_eq!(upright_image_size(&[0xff, 0xd8, 0xff, 0xda]), None, "no frame header");
    }

    #[test]
    fn webp_sizes_come_from_each_kind_of_header() {
        let lossy = webp(b"VP8 ", &[0, 0, 0, 0x9d, 0x01, 0x2a, 0x2c, 0x01, 0xc8, 0x00]);
        assert_eq!(upright_image_size(&lossy), Some((300, 200)));
        // 14 bits each of width − 1 and height − 1.
        let bits: u32 = 299 | (199 << 14);
        let mut lossless = vec![0x2f];
        lossless.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(upright_image_size(&webp(b"VP8L", &lossless)), Some((300, 200)));
        let extended = webp(b"VP8X", &[0x10, 0, 0, 0, 0x2b, 0x01, 0, 0xc7, 0, 0]);
        assert_eq!(upright_image_size(&extended), Some((300, 200)));
        let with_exif = webp(b"VP8X", &[0x18, 0, 0, 0, 0x2b, 0x01, 0, 0xc7, 0, 0]);
        assert_eq!(upright_image_size(&with_exif), None);
        assert_eq!(upright_image_size(b"not an image"), None);
    }
}
