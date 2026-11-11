//! Where a drawn plugin preview is put for an agent to read.

use std::path::PathBuf;

use eos_core::Error;
use eos_core::plugin::PluginPreviewFiles;

/// A new folder under the system's temporary folder per picture, as today.
/// The system clears it; nothing here does.
#[derive(Debug, Default, Clone, Copy)]
pub struct TempPreviewFiles;

impl PluginPreviewFiles for TempPreviewFiles {
    fn save(&self, stem: &str, png: &[u8]) -> Result<PathBuf, Error> {
        let folder = tempfile::Builder::new().prefix("eos-plugin-preview-").tempdir().map_err(Error::storage)?.keep();
        // The stem is made of a plugin id, a surface and a time: one file name.
        let path = folder.join(format!("{}.png", stem.replace(['/', '\\'], "-")));
        std::fs::write(&path, png).map_err(Error::storage)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_picture_gets_its_own_folder() {
        let a = TempPreviewFiles.save("clock-main-1", b"\x89PNG").expect("saves");
        let b = TempPreviewFiles.save("clock-main-1", b"\x89PNG").expect("saves");
        assert_ne!(a, b);
        assert_eq!(a.file_name().and_then(|n| n.to_str()), Some("clock-main-1.png"));
        assert_eq!(std::fs::read(&a).expect("the file"), b"\x89PNG");
        // A stem cannot name another folder.
        let outside = TempPreviewFiles.save("../../x", b"").expect("saves");
        assert_eq!(outside.file_name().and_then(|n| n.to_str()), Some("..-..-x.png"));
        for path in [a, b, outside] {
            let _ = std::fs::remove_dir_all(path.parent().expect("a folder"));
        }
    }
}
