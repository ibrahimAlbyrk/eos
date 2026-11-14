//! Small copies of the avatar, for drawing it at a known size. Each is a PNG named
//! `<size>-<length>-<modified>.png` in its own cache folder: the name holds what the
//! stored avatar was when the copy was made, so a new avatar is never answered with an
//! old copy, and writing a copy of a new avatar removes the old avatar's. An avatar has at
//! most one copy per size, and the sizes are few (`AVATAR_THUMBNAIL_SIZES`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use eos_contracts::AvatarExt;
use eos_core::Error;
use eos_core::store::{AvatarThumbnails, UserAvatar};
use eos_domain::avatar_thumbnail::{avatar_thumbnail_dims, upright_image_size};
use eos_platform::Desktop;

use crate::profile::avatar_file;

#[derive(Debug)]
pub struct FileAvatarThumbnails {
    /// The profile folder, where the avatar is stored.
    profile_dir: PathBuf,
    /// Only these copies live here.
    cache_dir: PathBuf,
    /// The system's image tool.
    desktop: &'static dyn Desktop,
    /// One copy is made at a time: two requests for the same size make it once.
    drawing: Mutex<()>,
}

impl FileAvatarThumbnails {
    pub fn new(profile_dir: impl Into<PathBuf>, cache_dir: impl Into<PathBuf>, desktop: &'static dyn Desktop) -> Self {
        Self { profile_dir: profile_dir.into(), cache_dir: cache_dir.into(), desktop, drawing: Mutex::new(()) }
    }

    fn read_copy(path: &Path) -> Option<UserAvatar> {
        fs::read(path).ok().map(|bytes| UserAvatar { bytes, ext: AvatarExt::Png })
    }

    /// Removes every copy that is not of the avatar `key` names, and any half-written one.
    fn forget_others(&self, key: &str) {
        let Ok(entries) = fs::read_dir(&self.cache_dir) else { return };
        let suffix = format!("-{key}.png");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let partial = name.starts_with('.');
            if partial || !name.ends_with(&suffix) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

impl AvatarThumbnails for FileAvatarThumbnails {
    fn thumbnail(&self, size: u32) -> Result<Option<UserAvatar>, Error> {
        let Some((path, ext)) = avatar_file(&self.profile_dir) else { return Ok(None) };
        let meta = fs::metadata(&path).map_err(Error::storage)?;
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        let key = format!("{}-{modified}", meta.len());
        let name = format!("{size}-{key}.png");
        let copy = self.cache_dir.join(&name);
        if let Some(found) = Self::read_copy(&copy) {
            return Ok(Some(found));
        }
        let _turn = self.drawing.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(found) = Self::read_copy(&copy) {
            return Ok(Some(found));
        }
        let original = UserAvatar { bytes: fs::read(&path).map_err(Error::storage)?, ext };
        let Some((width, height)) =
            upright_image_size(&original.bytes).and_then(|(w, h)| avatar_thumbnail_dims(w, h, size))
        else {
            return Ok(Some(original));
        };
        fs::create_dir_all(&self.cache_dir).map_err(Error::storage)?;
        let partial = self.cache_dir.join(format!(".{name}"));
        if self.desktop.render_scaled_image(&path, width, height, &partial).is_err() {
            let _ = fs::remove_file(&partial);
            return Ok(Some(original));
        }
        fs::rename(&partial, &copy).map_err(Error::storage)?;
        self.forget_others(&key);
        Ok(Some(Self::read_copy(&copy).unwrap_or(original)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Writes `scaled <w>x<h>` as the "PNG" and remembers each call.
    #[derive(Debug, Default)]
    struct FakeTool {
        calls: Mutex<Vec<(u32, u32)>>,
        refuse: bool,
    }

    impl Desktop for FakeTool {
        fn open_path(&self, _: &Path) -> Result<(), eos_platform::Error> {
            Ok(())
        }
        fn reveal_path(&self, _: &Path) -> Result<(), eos_platform::Error> {
            Ok(())
        }
        fn open_in(
            &self,
            _: eos_platform::OpenTarget<'_>,
            _: &Path,
            _: Option<u32>,
            _: Option<u32>,
        ) -> Result<(), eos_platform::Error> {
            Ok(())
        }
        fn app_installed(&self, _: &str) -> bool {
            false
        }
        fn default_app(&self, _: &Path) -> Option<eos_platform::DefaultApp> {
            None
        }
        fn render_app_icon(&self, _: &Path, _: &Path) -> Result<(), eos_platform::Error> {
            Ok(())
        }
        fn render_scaled_image(&self, _: &Path, w: u32, h: u32, out: &Path) -> Result<(), eos_platform::Error> {
            if self.refuse {
                return Err(eos_platform::Error::Unsupported("scaling images"));
            }
            self.calls.lock().unwrap_or_else(PoisonError::into_inner).push((w, h));
            fs::write(out, format!("scaled {w}x{h}"))
                .map_err(|e| eos_platform::Error::Tool { tool: "fake", detail: e.to_string() })
        }
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(b"IDAT");
        out
    }

    fn setup(tool: FakeTool) -> (tempfile::TempDir, &'static FakeTool, FileAvatarThumbnails) {
        let dir = tempfile::tempdir().expect("a folder");
        fs::create_dir_all(dir.path().join("profile")).expect("the profile folder");
        let tool: &'static FakeTool = Box::leak(Box::new(tool));
        let thumbs = FileAvatarThumbnails::new(dir.path().join("profile"), dir.path().join("cache"), tool);
        (dir, tool, thumbs)
    }

    fn calls(tool: &FakeTool) -> Vec<(u32, u32)> {
        tool.calls.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn cached(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir.join("cache"))
            .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn no_avatar_no_thumbnail() {
        let (_dir, _, thumbs) = setup(FakeTool::default());
        assert_eq!(thumbs.thumbnail(48).expect("reads"), None);
    }

    #[test]
    fn a_large_avatar_is_scaled_once_per_size_and_the_copy_is_reused() {
        let (dir, tool, thumbs) = setup(FakeTool::default());
        fs::write(dir.path().join("profile/avatar.png"), png(1024, 1536)).expect("an avatar");
        let small = thumbs.thumbnail(48).expect("reads").expect("an avatar");
        assert_eq!((small.ext, small.bytes), (AvatarExt::Png, b"scaled 48x72".to_vec()));
        assert_eq!(thumbs.thumbnail(48).expect("reads").expect("an avatar").bytes, b"scaled 48x72");
        assert_eq!(thumbs.thumbnail(96).expect("reads").expect("an avatar").bytes, b"scaled 96x144");
        assert_eq!(calls(tool), [(48, 72), (96, 144)], "each size is drawn once");
        assert_eq!(cached(dir.path()).len(), 2);
    }

    #[test]
    fn a_new_avatar_gets_new_copies_and_the_old_ones_go() {
        let (dir, tool, thumbs) = setup(FakeTool::default());
        fs::write(dir.path().join("profile/avatar.png"), png(1024, 1536)).expect("an avatar");
        thumbs.thumbnail(48).expect("reads");
        thumbs.thumbnail(96).expect("reads");
        fs::remove_file(dir.path().join("profile/avatar.png")).expect("removed");
        // A lossless WebP of 2000×1000: 14 bits each of width − 1 and height − 1.
        let mut webp = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        webp.extend_from_slice(&(1999u32 | (999 << 14)).to_le_bytes());
        fs::write(dir.path().join("profile/avatar.webp"), webp).expect("a webp");
        assert_eq!(thumbs.thumbnail(48).expect("reads").expect("an avatar").bytes, b"scaled 96x48");
        assert_eq!(calls(tool).last(), Some(&(96, 48)));
        assert_eq!(cached(dir.path()).len(), 1, "the old avatar's copies are gone");
    }

    #[test]
    fn an_avatar_that_is_small_already_or_cannot_be_scaled_is_sent_as_stored() {
        let (dir, tool, thumbs) = setup(FakeTool::default());
        let small = png(40, 40);
        fs::write(dir.path().join("profile/avatar.png"), &small).expect("an avatar");
        assert_eq!(thumbs.thumbnail(48).expect("reads"), Some(UserAvatar { bytes: small, ext: AvatarExt::Png }));
        fs::write(dir.path().join("profile/avatar.png"), b"\x89PNG\r\n\x1a\n not really").expect("a broken one");
        assert_eq!(thumbs.thumbnail(48).expect("reads").expect("an avatar").bytes, b"\x89PNG\r\n\x1a\n not really");
        assert!(calls(tool).is_empty());

        let (dir, _, thumbs) = setup(FakeTool { refuse: true, ..FakeTool::default() });
        let jpeg_like = png(1024, 1024);
        fs::write(dir.path().join("profile/avatar.png"), &jpeg_like).expect("an avatar");
        assert_eq!(thumbs.thumbnail(48).expect("reads").expect("an avatar").bytes, jpeg_like, "no image tool here");
        assert!(cached(dir.path()).is_empty(), "nothing half-written is left");
    }
}
