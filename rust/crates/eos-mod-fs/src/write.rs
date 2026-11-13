//! Changing files: write, paste, create, rename, move, trash. Each change
//! tells the kept git state of its working tree (`RepoState::touched`).

use std::path::Path;

use eos_contracts::{
    FsCreateRequest, FsCreateRequestType, FsMoveRequest, FsMoveResponse, FsMoveResponseResultsItem, FsMutationResponse,
    FsPasteB64Request, FsPasteB64Response, FsRenameRequest, FsTrashRequest, FsTrashResponse, FsTrashResponseFailedItem,
    FsWatchResponse, FsWriteRequest,
};
use eos_kit_fs::path::{is_inside, resolve_within_root};
use eos_runtime::http::{ApiError, Request, Response, percent_decode};
use eos_runtime::router::RouteDef;

use crate::Deps;
use crate::http::{CHANGE, Handled, abs_path, bad, guard_mutation, handler, require_user, text};

/// The largest pasted file.
const PASTE_MAX_BYTES: usize = 20 * 1024 * 1024;
/// Base64 grows a file by a third; the rest is room for the JSON around it.
const PASTE_B64_MAX_BODY_BYTES: usize = PASTE_MAX_BYTES.div_ceil(3) * 4 + 64 * 1024;
/// Pasted files land in `<temp>/eos-paste-<random>/<name>`.
const PASTE_PREFIX: &str = "eos-paste-";

/// A name that stays inside its folder.
fn file_name(name: &str) -> String {
    name.replace(['/', '\0'], "_")
}

/// What Node's `Buffer.from(text, "base64")` reads: characters outside the
/// alphabet are skipped, the URL-safe alphabet is accepted, and the data ends
/// at the first padding character.
fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u8);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = bits << 6 | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            (bits, count) = (0, 0);
        }
    }
    match count {
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        2 => out.push((bits >> 4) as u8),
        _ => {}
    }
    out
}

async fn write(deps: Deps, req: Request) -> Handled {
    let body: FsWriteRequest = req.parse()?;
    require_user(&req)?;
    // With a root (the Files panel) the path must stay inside it; without one
    // any absolute path is taken.
    let target = match &body.root {
        Some(root) => resolve_within_root(Path::new(root), &body.path).ok_or_else(|| bad("path escapes root"))?,
        None => abs_path(Some(&body.path), "absolute path required")?,
    };
    deps.files
        .write_text(&target, &body.content, body.mkdirp.unwrap_or(false))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    deps.repo_state.touched(&target);
    Ok(Response::json(200, &FsWatchResponse { ok: true }))
}

async fn paste(deps: Deps, req: Request) -> Handled {
    if !req.headers.get("content-type").unwrap_or_default().starts_with("application/octet-stream") {
        return Err(bad("content-type must be application/octet-stream"));
    }
    let Some(sent) = req.headers.get("x-filename").filter(|name| !name.is_empty()) else {
        return Err(bad("x-filename header required"));
    };
    // The dashboard percent-encodes the name (headers are Latin-1 only); a
    // name from an older client that is not valid encoding is kept as sent.
    let name = percent_decode(sent).map_or_else(|| sent.to_owned(), |decoded| decoded.into_owned());
    let path = deps
        .files
        .write_temp(PASTE_PREFIX, &file_name(&name), &req.body)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Response::json(200, &FsPasteB64Response { path: text(&path) }))
}

// The JSON twin of `paste`, for callers that can only send JSON (the phone).
async fn paste_b64(deps: Deps, req: Request) -> Handled {
    let body: FsPasteB64Request = req.parse()?;
    let bytes = decode_base64(&body.data_b64);
    if bytes.len() > PASTE_MAX_BYTES {
        let message = format!("payload too large ({} bytes, limit {PASTE_MAX_BYTES})", bytes.len());
        return Err(ApiError::status_with(413, message));
    }
    let path = deps
        .files
        .write_temp(PASTE_PREFIX, &file_name(&body.name), &bytes)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Response::json(200, &FsPasteB64Response { path: text(&path) }))
}

fn mutated(path: &Path) -> Response {
    Response::json(200, &FsMutationResponse { ok: true, path: Some(text(path)), error: None })
}

async fn create(deps: Deps, req: Request) -> Handled {
    let body: FsCreateRequest = req.parse()?;
    let root = guard_mutation(&req, &body.root)?;
    let target = resolve_within_root(&root, &body.path).ok_or_else(|| bad("path escapes root"))?;
    match body.r#type {
        FsCreateRequestType::Directory => deps.files.mkdir(&target).await?,
        FsCreateRequestType::File => {
            deps.files.create_file(&target, body.content.as_deref().unwrap_or_default()).await?
        }
    }
    deps.repo_state.touched(&target);
    Ok(mutated(&target))
}

async fn rename(deps: Deps, req: Request) -> Handled {
    let body: FsRenameRequest = req.parse()?;
    let root = guard_mutation(&req, &body.root)?;
    let from = resolve_within_root(&root, &body.path).ok_or_else(|| bad("path escapes root"))?;
    // The new name is a bare file name (the request type checks it), so the
    // target is in the same folder, which is inside the root.
    let to = from.parent().unwrap_or(&root).join(&body.new_name);
    deps.files.rename(&from, &to).await?;
    deps.repo_state.touched(&root);
    Ok(mutated(&to))
}

async fn move_entries(deps: Deps, req: Request) -> Handled {
    let body: FsMoveRequest = req.parse()?;
    let root = guard_mutation(&req, &body.root)?;
    let dest_dir = resolve_within_root(&root, &body.dest_dir).ok_or_else(|| bad("destDir escapes root"))?;
    let mut results = Vec::with_capacity(body.paths.len());
    for path in body.paths {
        let failed = |error: String| Some(error);
        let error = match resolve_within_root(&root, &path) {
            None => failed("path escapes root".into()),
            Some(from) => {
                let to = dest_dir.join(from.file_name().unwrap_or_default());
                if to == from {
                    failed("already in destination".into())
                } else if is_inside(&from, &dest_dir) {
                    failed("cannot move a folder into itself".into())
                } else {
                    deps.files
                        .move_entry(&from, &to, body.overwrite.unwrap_or(false))
                        .await
                        .err()
                        .map(|e| e.to_string())
                }
            }
        };
        results.push(FsMoveResponseResultsItem { from: path, ok: error.is_none(), error });
    }
    deps.repo_state.touched(&root);
    Ok(Response::json(200, &FsMoveResponse { ok: results.iter().all(|r| r.ok), results }))
}

async fn trash(deps: Deps, req: Request) -> Handled {
    let body: FsTrashRequest = req.parse()?;
    let root = guard_mutation(&req, &body.root)?;
    let (mut trashed, mut failed) = (Vec::new(), Vec::new());
    for path in body.paths {
        let outcome = match resolve_within_root(&root, &path) {
            None => Err("path escapes root".to_owned()),
            Some(target) => deps.files.trash(&target).await.map_err(|e| e.to_string()),
        };
        match outcome {
            Ok(()) => trashed.push(path),
            Err(error) => failed.push(FsTrashResponseFailedItem { path, error }),
        }
    }
    deps.repo_state.touched(&root);
    Ok(Response::json(200, &FsTrashResponse { ok: failed.is_empty(), trashed, failed }))
}

pub(crate) fn routes(deps: &Deps) -> Vec<RouteDef> {
    vec![
        RouteDef::post("/fs/write", handler(deps, write)).access(CHANGE),
        RouteDef::post("/fs/paste", handler(deps, paste)).access(CHANGE).max_body(PASTE_MAX_BYTES),
        RouteDef::post("/fs/paste-b64", handler(deps, paste_b64)).access(CHANGE).max_body(PASTE_B64_MAX_BODY_BYTES),
        RouteDef::post("/fs/create", handler(deps, create)).access(CHANGE),
        RouteDef::post("/fs/rename", handler(deps, rename)).access(CHANGE),
        RouteDef::post("/fs/move", handler(deps, move_entries)).access(CHANGE),
        RouteDef::post("/fs/trash", handler(deps, trash)).access(CHANGE),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each expectation is what `Buffer.from(text, "base64")` gives in Node 26.
    #[test]
    fn base64_is_read_as_leniently_as_node_reads_it() {
        assert_eq!(decode_base64("cGFzdGVkIGJ5dGVz"), b"pasted bytes");
        assert_eq!(decode_base64("aGk="), b"hi");
        assert_eq!(decode_base64("aGk"), b"hi");
        assert_eq!(decode_base64("aG k\n"), b"hi");
        assert_eq!(decode_base64("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(decode_base64("aGk=aGk="), b"hi");
        assert_eq!(decode_base64("a"), b"");
        assert_eq!(decode_base64("!!!"), b"");
    }

    #[test]
    fn a_pasted_name_cannot_leave_its_folder() {
        assert_eq!(file_name("clip.txt"), "clip.txt");
        assert_eq!(file_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(file_name("a\0b"), "a_b");
    }
}
