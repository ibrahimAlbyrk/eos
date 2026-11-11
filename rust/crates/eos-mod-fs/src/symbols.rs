//! Go to definition, find references, symbol search and one file's outline.
//! Reads like the other file routes: the root is an absolute path and a file
//! must resolve inside it.

use std::sync::Arc;

use eos_contracts::{SymbolsFileResponse, SymbolsLookupResponse, SymbolsSearchResponse};
use eos_core::os::SymbolIndex;
use eos_kit_fs::path::resolve_within_root;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;

use crate::http::{DASHBOARD, Handled, abs_path, bad};

fn failed(e: eos_core::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

async fn lookup(index: Arc<dyn SymbolIndex>, req: Request) -> Handled {
    let query = req.query();
    let root = abs_path(query.get("root").as_deref(), "root must be absolute")?;
    let Some(name) = query.get("name").filter(|n| !n.is_empty()) else { return Err(bad("name required")) };
    let references = query.get("want").as_deref() == Some("references");
    // Where the lookup comes from only orders the answers; one that does not
    // resolve inside the root is left out.
    let from_path = query.get("fromPath").filter(|p| !p.is_empty() && resolve_within_root(&root, p).is_some());
    index.ensure_indexed(&root).await.map_err(failed)?;
    let occurrences = if references {
        index.references(&root, &name).await
    } else {
        index.definitions(&root, &name, from_path.as_deref()).await
    }
    .map_err(failed)?;
    Ok(Response::json(200, &SymbolsLookupResponse { occurrences, indexing: None }))
}

async fn file(index: Arc<dyn SymbolIndex>, req: Request) -> Handled {
    let query = req.query();
    let root = abs_path(query.get("root").as_deref(), "root must be absolute")?;
    let path = query.get("path").filter(|p| !p.is_empty()).and_then(|p| resolve_within_root(&root, &p));
    let Some(path) = path else { return Err(bad("path must resolve within root")) };
    let occurrences = index.definitions_in_file(&root, &path).await.map_err(failed)?;
    Ok(Response::json(200, &SymbolsFileResponse { occurrences }))
}

async fn search(index: Arc<dyn SymbolIndex>, req: Request) -> Handled {
    let query = req.query();
    let root = abs_path(query.get("root").as_deref(), "root must be absolute")?;
    let wanted = query.get("query").unwrap_or_default().trim().to_owned();
    if wanted.is_empty() {
        return Ok(Response::json(200, &SymbolsSearchResponse { symbols: Vec::new() }));
    }
    let asked = query.get("limit").and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| *n != 0.0 && !n.is_nan());
    let limit = asked.unwrap_or(50.0).min(200.0).trunc().max(0.0) as usize;
    index.ensure_indexed(&root).await.map_err(failed)?;
    let symbols = index.search(&root, &wanted, limit).await.map_err(failed)?;
    Ok(Response::json(200, &SymbolsSearchResponse { symbols }))
}

pub(crate) fn routes(index: &Arc<dyn SymbolIndex>) -> Vec<RouteDef> {
    let with = |run: fn(Arc<dyn SymbolIndex>, Request) -> _| {
        let index = index.clone();
        move |req: Request| run(index.clone(), req)
    };
    vec![
        RouteDef::get("/symbols/lookup", with(|i, r| Box::pin(lookup(i, r)) as BoxedHandled)).access(DASHBOARD),
        RouteDef::get("/symbols/file", with(|i, r| Box::pin(file(i, r)) as BoxedHandled)).access(DASHBOARD),
        RouteDef::get("/symbols/search", with(|i, r| Box::pin(search(i, r)) as BoxedHandled)).access(DASHBOARD),
    ]
}

type BoxedHandled = std::pin::Pin<Box<dyn Future<Output = Handled> + Send>>;
