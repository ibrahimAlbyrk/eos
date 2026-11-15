//! What the workers feature offers the rest of the app: worker rows as its
//! list route serves them, without reading the whole list.

use std::collections::HashMap;

use crate::{BoxFuture, Error};

/// The rows one of the worker list routes serves (`GET /workers`, or its
/// brief rows), for some ids.
pub trait ListedWorkers: Send + Sync + 'static {
    /// Each listed row among `ids`, by id, serialized byte for byte as the
    /// route serializes it in its list. An id the route does not list (an
    /// archived, removed or unknown worker) has no entry.
    fn rows<'a>(&'a self, ids: &'a [String]) -> BoxFuture<'a, Result<HashMap<String, Vec<u8>>, Error>>;
}
