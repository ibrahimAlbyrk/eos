//! Watches a dashboard tab holds: folders of the Files panel and the git
//! state of folders no running agent keeps live.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_contracts::{FsUnwatchRequest, FsWatchRequest, FsWatchResponse, GitWatchRequest};
use eos_core::os::WatchLease;
use eos_kit_fs::path::resolve_within_root;
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;

use crate::Deps;
use crate::http::{CHANGE, Handled, bad, guard_mutation, handler, require_user};

/// Watches one tab may hold. Past it the tab's oldest watch is given back:
/// a watch is a system resource, and a tab asks for one per expanded folder.
const MAX_PER_TAB: usize = 1024;
/// Tabs remembered. A tab's watches go when its stream closes, so this is
/// only reached by callers that watch without ever opening a stream.
const MAX_TABS: usize = 512;

/// Which tab holds which watch, so a tab that goes away (closed, reloaded,
/// crashed) gives everything back even if it never said so. The watcher
/// behind the leases counts holders: two tabs on one folder share its watch.
#[derive(Default)]
pub(crate) struct WatchLeases {
    /// Per tab, in the order the watches were taken.
    by_tab: Mutex<HashMap<String, Vec<(PathBuf, WatchLease)>>>,
    /// Held by each change of these watches until the system's watch has started
    /// or ended, taken in the order the changes were asked for: one never
    /// overtakes another, and a route answers only once its change is done.
    turn: Arc<tokio::sync::Mutex<()>>,
}

impl WatchLeases {
    /// Holds a watch of `dir` for `tab`; `take` starts it. A folder the tab
    /// already watches is not watched twice.
    pub(crate) fn watch(&self, tab: &str, dir: &Path, take: impl FnOnce() -> WatchLease) {
        let mut tabs = self.by_tab.lock().unwrap_or_else(|p| p.into_inner());
        if !tabs.contains_key(tab) && tabs.len() >= MAX_TABS {
            tracing::warn!(tab, "too many tabs hold watches; this watch is not started");
            return;
        }
        let held = tabs.entry(tab.to_owned()).or_default();
        if held.iter().any(|(watched, _)| watched == dir) {
            return;
        }
        if held.len() >= MAX_PER_TAB {
            held.remove(0);
        }
        held.push((dir.to_owned(), take()));
    }

    pub(crate) fn unwatch(&self, tab: &str, dir: &Path) {
        let mut tabs = self.by_tab.lock().unwrap_or_else(|p| p.into_inner());
        let Some(held) = tabs.get_mut(tab) else { return };
        held.retain(|(watched, _)| watched != dir);
        if held.is_empty() {
            tabs.remove(tab);
        }
    }

    /// Every watch the tab holds is given back.
    pub(crate) fn drop_tab(&self, tab: &str) {
        let held = self.by_tab.lock().unwrap_or_else(|p| p.into_inner()).remove(tab);
        drop(held);
    }

    /// Runs `change` in its turn on a blocking thread (starting or ending a
    /// system watch restarts the system's stream) and returns once it is done.
    /// A request dropped meanwhile still lets a started change finish in its turn.
    /// A change that panics fails its request, as one run on the request's own thread does.
    async fn in_turn(self: &Arc<Self>, change: impl FnOnce(&Self) + Send + 'static) {
        let turn = self.turn.clone().lock_owned().await;
        let leases = self.clone();
        let done = tokio::task::spawn_blocking(move || {
            change(&leases);
            drop(turn);
        })
        .await;
        if let Err(failed) = done
            && failed.is_panic()
        {
            std::panic::resume_unwind(failed.into_panic());
        }
    }

    /// The tab's stream closed: every watch it held is given back. They leave
    /// the list at once, so what the tab watches again after a reload is its
    /// own, and end in a turn of their own: when no change is running, before
    /// any change asked for after this; else after the changes already waiting.
    pub(crate) fn tab_gone(&self, tab: &str) {
        let Some(held) = self.by_tab.lock().unwrap_or_else(|p| p.into_inner()).remove(tab) else { return };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return drop(held) };
        match self.turn.clone().try_lock_owned() {
            Ok(turn) => drop(runtime.spawn_blocking(move || {
                drop(held);
                drop(turn);
            })),
            Err(_) => {
                let turn = self.turn.clone();
                drop(runtime.spawn(async move {
                    let turn = turn.lock_owned().await;
                    let _ = tokio::task::spawn_blocking(move || {
                        drop(held);
                        drop(turn);
                    })
                    .await;
                }));
            }
        }
    }

    #[cfg(test)]
    fn held(&self, tab: &str) -> usize {
        self.by_tab.lock().unwrap_or_else(|p| p.into_inner()).get(tab).map_or(0, Vec::len)
    }
}

fn ok() -> Response {
    Response::json(200, &FsWatchResponse { ok: true })
}

async fn watch(deps: Deps, req: Request) -> Handled {
    let body: FsWatchRequest = req.parse()?;
    let root = guard_mutation(&req, &body.root)?;
    let dir = resolve_within_root(&root, &body.dir).ok_or_else(|| bad("dir escapes root"))?;
    let (watcher, tab) = (deps.file_watcher.clone(), body.client_id);
    deps.file_leases.in_turn(move |leases| leases.watch(&tab, &dir, || watcher.watch(&dir))).await;
    Ok(ok())
}

async fn unwatch(deps: Deps, req: Request) -> Handled {
    let body: FsUnwatchRequest = req.parse()?;
    require_user(&req)?;
    let tab = body.client_id;
    if body.all.unwrap_or(false) {
        deps.file_leases.in_turn(move |leases| leases.drop_tab(&tab)).await;
    } else if let (Some(root), Some(dir)) = (body.root.filter(|r| !r.is_empty()), body.dir.filter(|d| !d.is_empty()))
        && let Some(dir) = resolve_within_root(Path::new(&root), &dir)
    {
        deps.file_leases.in_turn(move |leases| leases.unwatch(&tab, &dir)).await;
    }
    Ok(ok())
}

async fn git_watch(deps: Deps, req: Request) -> Handled {
    let body: GitWatchRequest = req.parse()?;
    let dir = guard_mutation(&req, &body.dir)?;
    let (watcher, tab) = (deps.git_watcher.clone(), body.client_id);
    deps.git_leases.in_turn(move |leases| leases.watch(&tab, &dir, || watcher.watch(&dir))).await;
    Ok(ok())
}

async fn git_unwatch(deps: Deps, req: Request) -> Handled {
    let body: GitWatchRequest = req.parse()?;
    require_user(&req)?;
    let (tab, dir) = (body.client_id, PathBuf::from(body.dir));
    deps.git_leases.in_turn(move |leases| leases.unwatch(&tab, &dir)).await;
    Ok(ok())
}

pub(crate) fn routes(deps: &Deps) -> Vec<RouteDef> {
    vec![
        RouteDef::post("/fs/watch", handler(deps, watch)).access(CHANGE),
        RouteDef::post("/fs/unwatch", handler(deps, unwatch)).access(CHANGE),
        RouteDef::post("/fs/git/watch", handler(deps, git_watch)).access(CHANGE),
        RouteDef::post("/fs/git/unwatch", handler(deps, git_unwatch)).access(CHANGE),
    ]
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Counts leases taken and given back.
    #[derive(Default)]
    struct Counter {
        taken: AtomicUsize,
        released: Arc<AtomicUsize>,
    }

    impl Counter {
        fn lease(&self) -> WatchLease {
            self.taken.fetch_add(1, Ordering::SeqCst);
            let released = self.released.clone();
            WatchLease::new(move || {
                released.fetch_add(1, Ordering::SeqCst);
            })
        }

        fn live(&self) -> usize {
            self.taken.load(Ordering::SeqCst) - self.released.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn a_tab_watches_a_folder_once_and_gives_it_back_on_unwatch() {
        let (leases, counter) = (WatchLeases::default(), Counter::default());
        let (a, b) = (Path::new("/p/a"), Path::new("/p/b"));
        leases.watch("tab-1", a, || counter.lease());
        leases.watch("tab-1", a, || counter.lease());
        leases.watch("tab-1", b, || counter.lease());
        leases.watch("tab-2", a, || counter.lease());
        assert_eq!((counter.live(), leases.held("tab-1")), (3, 2));

        leases.unwatch("tab-1", a);
        leases.unwatch("tab-1", Path::new("/never/watched"));
        leases.unwatch("no-such-tab", a);
        assert_eq!((counter.live(), leases.held("tab-1")), (2, 1));
    }

    #[test]
    fn a_tab_that_goes_away_gives_everything_back() {
        let (leases, counter) = (WatchLeases::default(), Counter::default());
        for dir in ["/p/a", "/p/b", "/p/c"] {
            leases.watch("tab-1", Path::new(dir), || counter.lease());
        }
        leases.watch("tab-2", Path::new("/p/a"), || counter.lease());
        leases.drop_tab("tab-1");
        leases.drop_tab("tab-1");
        assert_eq!((counter.live(), leases.held("tab-1"), leases.held("tab-2")), (1, 0, 1));
    }

    #[test]
    fn a_tab_holds_a_bounded_number_of_watches() {
        let (leases, counter) = (WatchLeases::default(), Counter::default());
        for i in 0..MAX_PER_TAB + 10 {
            leases.watch("tab-1", Path::new(&format!("/p/{i}")), || counter.lease());
        }
        assert_eq!((counter.live(), leases.held("tab-1")), (MAX_PER_TAB, MAX_PER_TAB));
        // The oldest were given back; the newest are held.
        leases.unwatch("tab-1", Path::new("/p/0"));
        assert_eq!(counter.live(), MAX_PER_TAB);
        leases.unwatch("tab-1", Path::new(&format!("/p/{}", MAX_PER_TAB + 9)));
        assert_eq!(counter.live(), MAX_PER_TAB - 1);
    }
}
