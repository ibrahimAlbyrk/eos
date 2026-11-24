//! The images of routine surfaces, `<data folder>/surfaces/<id>/img/<sha256>.jpg|png`
//! ([`eos_core::surface::SurfaceImages`]).
//!
//! An image is had once, when its issue is filled: through the guarded
//! [`MediaFetcher`] for a URL, or from the run's own output folder. It is
//! decoded (JPEG, PNG, GIF or WebP only, with the decoder's size limits),
//! scaled to at most 1,600 px wide and written again, as JPEG at quality 80
//! or as PNG when it has transparency: what was in the file besides its
//! pixels (EXIF, location) is gone. It is named by the SHA-256 of what was
//! written, so the same picture is stored once.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use eos_core::net::MediaFetcher;
use eos_core::surface::{ImageFailure, ImageRef, ImageSource, StoredImage, SurfaceImages};
use eos_core::{BoxFuture, Error};
use eos_kit_fs::{Flush, WriteOptions, atomic_write};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};

/// The largest file an image may come in.
pub const IMAGE_SOURCE_BYTES: usize = 10 * 1024 * 1024;
/// The widest an image is stored.
pub const STORED_WIDTH: u32 = 1600;
const JPEG_QUALITY: u8 = 80;
/// What the decoder may allocate for one image, against a picture that
/// claims a huge size in a few bytes.
const DECODE_BYTES: u64 = 256 * 1024 * 1024;
const DECODE_SIDE: u32 = 12_000;

pub struct FileSurfaceImages {
    /// The data folder's `surfaces`.
    root: PathBuf,
    fetcher: Arc<dyn MediaFetcher>,
}

impl std::fmt::Debug for FileSurfaceImages {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileSurfaceImages").field("root", &self.root).finish_non_exhaustive()
    }
}

impl FileSurfaceImages {
    pub fn new(root: impl Into<PathBuf>, fetcher: Arc<dyn MediaFetcher>) -> Self {
        Self { root: root.into(), fetcher }
    }

    fn dir(&self, surface_id: &str) -> Option<PathBuf> {
        is_name(surface_id).then(|| self.root.join(surface_id).join("img"))
    }
}

/// A surface id or an image hash: nothing that could leave the folder.
fn is_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= 80 && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

impl SurfaceImages for FileSurfaceImages {
    fn intake<'a>(&'a self, surface_id: &'a str, src: ImageSource) -> BoxFuture<'a, Result<ImageRef, ImageFailure>> {
        Box::pin(async move {
            let dir = self.dir(surface_id).ok_or(ImageFailure::Unreadable)?;
            let raw = match src {
                ImageSource::Url(url) => self.fetcher.image(&url).await.ok_or(ImageFailure::Unreachable)?.body,
                ImageSource::RunFile(path) => tokio::task::spawn_blocking(move || read_run_file(&path))
                    .await
                    .map_err(|_| ImageFailure::Unreadable)??,
            };
            if raw.len() > IMAGE_SOURCE_BYTES {
                return Err(ImageFailure::TooLarge);
            }
            tokio::task::spawn_blocking(move || {
                let image = decode(&raw)?;
                let image = scale(image, STORED_WIDTH);
                let (content_type, body) = encode(&image)?;
                let hash = hex(&Sha256::digest(&body));
                let path = dir.join(format!("{hash}.{}", ext(content_type)));
                if !path.exists() {
                    atomic_write(&path, &body, &WriteOptions { flush: Flush::Full, ..WriteOptions::default() })
                        .map_err(|_| ImageFailure::Unreadable)?;
                }
                Ok(ImageRef {
                    hash,
                    content_type: content_type.to_owned(),
                    width: image.width(),
                    height: image.height(),
                    bytes: body.len() as u64,
                })
            })
            .await
            .map_err(|_| ImageFailure::Unreadable)?
        })
    }

    fn read<'a>(
        &'a self,
        surface_id: &'a str,
        hash: &'a str,
        max_width: Option<u32>,
    ) -> BoxFuture<'a, Result<Option<StoredImage>, Error>> {
        Box::pin(async move {
            let Some(dir) = self.dir(surface_id).filter(|_| is_hash(hash)) else { return Ok(None) };
            let hash = hash.to_owned();
            tokio::task::spawn_blocking(move || {
                for (content_type, ext) in [("image/jpeg", "jpg"), ("image/png", "png")] {
                    let path = dir.join(format!("{hash}.{ext}"));
                    let body = match std::fs::read(&path) {
                        Ok(body) => body,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(e) => return Err(Error::Storage(format!("image {}: {e}", path.display()))),
                    };
                    let Some(width) = max_width else {
                        return Ok(Some(StoredImage {
                            content_type: content_type.to_owned(),
                            body: Bytes::from(body),
                        }));
                    };
                    let Ok(image) = decode(&body) else { return Ok(None) };
                    if image.width() <= width {
                        return Ok(Some(StoredImage {
                            content_type: content_type.to_owned(),
                            body: Bytes::from(body),
                        }));
                    }
                    let Ok((content_type, body)) = encode(&scale(image, width)) else { return Ok(None) };
                    return Ok(Some(StoredImage { content_type: content_type.to_owned(), body: Bytes::from(body) }));
                }
                Ok(None)
            })
            .await
            .map_err(|e| Error::Storage(format!("image read stopped: {e}")))?
        })
    }

    fn collect<'a>(&'a self, surface_id: &'a str, keep: &'a [String]) -> BoxFuture<'a, Result<u64, Error>> {
        Box::pin(async move {
            let Some(dir) = self.dir(surface_id) else { return Ok(0) };
            let keep = keep.to_vec();
            tokio::task::spawn_blocking(move || remove_others(&dir, &keep))
                .await
                .map_err(|e| Error::Storage(format!("image collection stopped: {e}")))?
        })
    }
}

fn read_run_file(path: &Path) -> Result<Bytes, ImageFailure> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| ImageFailure::Unreachable)?;
    // A link could point anywhere; the run's own file is a plain file.
    if !meta.is_file() {
        return Err(ImageFailure::Unreachable);
    }
    if meta.len() > IMAGE_SOURCE_BYTES as u64 {
        return Err(ImageFailure::TooLarge);
    }
    std::fs::read(path).map(Bytes::from).map_err(|_| ImageFailure::Unreachable)
}

fn decode(raw: &[u8]) -> Result<DynamicImage, ImageFailure> {
    let mut reader = ImageReader::new(Cursor::new(raw)).with_guessed_format().map_err(|_| ImageFailure::NotAnImage)?;
    match reader.format() {
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP) => {}
        _ => return Err(ImageFailure::NotAnImage),
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(DECODE_BYTES);
    limits.max_image_width = Some(DECODE_SIDE);
    limits.max_image_height = Some(DECODE_SIDE);
    reader.limits(limits);
    reader.decode().map_err(|_| ImageFailure::Unreadable)
}

fn scale(image: DynamicImage, width: u32) -> DynamicImage {
    if image.width() <= width {
        return image;
    }
    let height = (u64::from(image.height()) * u64::from(width) / u64::from(image.width())).max(1);
    image.resize_exact(width, u32::try_from(height).unwrap_or(u32::MAX), image::imageops::FilterType::Triangle)
}

fn encode(image: &DynamicImage) -> Result<(&'static str, Vec<u8>), ImageFailure> {
    let mut out = Vec::new();
    if image.color().has_alpha() {
        image.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(|_| ImageFailure::Unreadable)?;
        return Ok(("image/png", out));
    }
    let rgb = image.to_rgb8();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&rgb).map_err(|_| ImageFailure::Unreadable)?;
    Ok(("image/jpeg", out))
}

fn ext(content_type: &str) -> &'static str {
    if content_type == "image/png" { "png" } else { "jpg" }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn remove_others(dir: &Path, keep: &[String]) -> Result<u64, Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(Error::Storage(format!("images {}: {e}", dir.display()))),
    };
    let mut freed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if !is_hash(stem) || keep.iter().any(|k| k == stem) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            freed += size;
        }
    }
    Ok(freed)
}
