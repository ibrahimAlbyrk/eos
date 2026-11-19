//! A routine run's folders under `<data folder>/routines`
//! ([`eos_core::routine::RunFolders`]).

use std::path::{Path, PathBuf};

use eos_core::routine::{KeptFile, RUN_FILE_MAX_BYTES, RunFolders};
use eos_core::{BoxFuture, Error};

/// The folders under `root`, the data folder's `routines`.
#[derive(Debug, Clone)]
pub struct FsRunFolders {
    root: PathBuf,
}

impl FsRunFolders {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn run_dir(&self, routine_id: &str, run_id: &str) -> PathBuf {
        self.root.join(routine_id).join("runs").join(run_id)
    }
}

impl RunFolders for FsRunFolders {
    fn work_dir(&self, routine_id: &str, run_id: &str) -> Result<PathBuf, Error> {
        let dir = self.run_dir(routine_id, run_id).join("work");
        std::fs::create_dir_all(&dir).map_err(|e| Error::storage(format!("the run's working folder: {e}")))?;
        Ok(dir)
    }

    fn keep_files<'a>(
        &'a self,
        routine_id: &'a str,
        run_id: &'a str,
        files: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<KeptFile>, Error>> {
        let dir = self.run_dir(routine_id, run_id).join("files");
        let files = files.to_vec();
        Box::pin(async move {
            match tokio::task::spawn_blocking(move || keep(&dir, &files)).await {
                Ok(kept) => kept,
                Err(e) => Err(Error::storage(e.to_string())),
            }
        })
    }
}

fn keep(dir: &Path, files: &[String]) -> Result<Vec<KeptFile>, Error> {
    let mut kept: Vec<KeptFile> = Vec::with_capacity(files.len());
    if files.is_empty() {
        return Ok(kept);
    }
    std::fs::create_dir_all(dir).map_err(|e| Error::storage(format!("the run's files folder: {e}")))?;
    for file in files {
        let from = Path::new(file);
        let meta = std::fs::metadata(from).map_err(|_| Error::Validation(format!("files: {file} cannot be read")))?;
        if !meta.is_file() {
            return Err(Error::Validation(format!("files: {file} is not a file")));
        }
        if meta.len() > RUN_FILE_MAX_BYTES {
            return Err(Error::Validation(format!("files: {file} is larger than {RUN_FILE_MAX_BYTES} bytes")));
        }
        let name = free_name(dir, from, &kept);
        // A copy of the content: a link would let its target change after the check.
        let bytes = std::fs::copy(from, dir.join(&name)).map_err(|e| Error::storage(format!("files: {e}")))?;
        kept.push(KeptFile { name, bytes });
    }
    Ok(kept)
}

/// The file's own name, or `name-2.ext`, `name-3.ext`, … when it is taken.
fn free_name(dir: &Path, from: &Path, kept: &[KeptFile]) -> String {
    let stem = from.file_stem().map_or_else(|| "file".to_owned(), |s| s.to_string_lossy().into_owned());
    let ext = from.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let taken = |name: &str| dir.join(name).exists() || kept.iter().any(|k| k.name == name);
    let mut name = format!("{stem}{ext}");
    let mut n = 2;
    while taken(&name) {
        name = format!("{stem}-{n}{ext}");
        n += 1;
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn files_are_copied_under_free_names_and_a_folder_is_refused() {
        let temp = tempfile::tempdir().expect("a folder");
        let source = temp.path().join("src");
        std::fs::create_dir_all(source.join("sub")).expect("folders");
        std::fs::write(source.join("report.md"), "one").expect("a file");
        std::fs::write(source.join("sub/report.md"), "two!").expect("a file");
        let folders = FsRunFolders::new(temp.path().join("routines"));
        let files = [source.join("report.md"), source.join("sub/report.md")].map(|p| p.to_string_lossy().into_owned());

        let kept = folders.keep_files("rt-1", "rn-1", &files).await.expect("kept");
        assert_eq!(
            kept,
            [KeptFile { name: "report.md".into(), bytes: 3 }, KeptFile { name: "report-2.md".into(), bytes: 4 }]
        );
        let dir = temp.path().join("routines/rt-1/runs/rn-1/files");
        assert_eq!(std::fs::read_to_string(dir.join("report-2.md")).expect("copied"), "two!");
        assert!(!std::fs::symlink_metadata(dir.join("report.md")).expect("there").file_type().is_symlink());

        let folder = [source.join("sub").to_string_lossy().into_owned()];
        assert!(matches!(folders.keep_files("rt-1", "rn-1", &folder).await, Err(Error::Validation(_))));
        let work = folders.work_dir("rt-1", "rn-1").expect("made");
        assert!(work.ends_with("routines/rt-1/runs/rn-1/work") && work.is_dir());
    }
}
