//! The plugin system over its real adapters on a throwaway data folder.

#![allow(dead_code, unreachable_pub)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_core::plugin::{PluginBuilder, PluginCloner, PluginFetcher, PluginPreviewer};
use eos_core::{BoxFuture, Clock, RandomIds, SystemClock};
use eos_kit_proc::{ProcessTrees, Runner as Processes};
use eos_mod_plugins::{NoPreviewWindow, PluginHost, PluginHostDeps, PluginServiceOptions};
use eos_plugin_build::{EsbuildPluginBuilder, dev_checkout, locate};
use eos_plugin_files::{
    FsPluginDataStore, FsPluginInstallStore, FsPluginStaging, FsPluginWorkspace, HttpFailure, PluginFetchers,
    RegistryHttp, TempPreviewFiles,
};
use eos_runtime::access::{Access, Caller};
use eos_runtime::http::{Method, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::{RouteDef, Router};
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::TempHome;
use serde_json::{Value, json};

pub fn processes() -> Processes {
    Processes::new(ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok()))
}

/// The esbuild `npm ci` put under `infra/node_modules`, or `EOS_ESBUILD`.
pub fn esbuild() -> Option<PathBuf> {
    let given = std::env::var_os("EOS_ESBUILD").map(PathBuf::from);
    locate(given.as_deref(), dev_checkout().as_deref())
}

/// A registry nobody is asked: the recorded scenarios install from a folder.
pub struct NoRegistry;

impl RegistryHttp for NoRegistry {
    fn get<'a>(&'a self, _: &'a str, _: Option<&'a str>, _: usize) -> BoxFuture<'a, Result<Vec<u8>, HttpFailure>> {
        Box::pin(std::future::ready(Err(HttpFailure::Unreachable("no registry in this test".into()))))
    }
}

/// The pages feature as far as its switch goes: one list route, one create route.
struct PagesStub;

impl Module for PagesStub {
    fn id(&self) -> &'static str {
        "pages"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(eos_contracts::builtin_plugins::ids::PAGES)
    }

    fn routes(&self) -> Vec<RouteDef> {
        let list = |_req: Request| async { Ok(Response::json(200, &json!({ "pages": [] }))) };
        let create = |_req: Request| async { Ok(Response::json(201, &json!({ "page": {} }))) };
        vec![
            RouteDef::get("/api/pages", list).access(Access::open()),
            RouteDef::post("/api/pages", create).access(Access::ui_token()),
        ]
    }
}

/// What a test may swap.
pub struct Parts {
    pub registry: Arc<dyn RegistryHttp>,
    pub cloner: Arc<dyn PluginCloner>,
    pub builder: Arc<dyn PluginBuilder>,
    pub previewer: Arc<dyn PluginPreviewer>,
    pub settle_timeout: Duration,
}

impl Default for Parts {
    fn default() -> Self {
        Self {
            registry: Arc::new(NoRegistry),
            cloner: Arc::new(eos_git::PluginClones::new(eos_git::Git::new(processes(), Arc::new(SystemClock)))),
            builder: Arc::new(EsbuildPluginBuilder::new(processes(), esbuild())),
            previewer: Arc::new(NoPreviewWindow),
            settle_timeout: Duration::from_millis(300),
        }
    }
}

/// The plugin system on a data folder of its own.
pub struct World {
    pub home: TempHome,
    pub sandbox: PathBuf,
    pub host: Arc<PluginHost>,
    pub runtime: Runtime,
}

impl World {
    /// The wire fixtures' synthetic folder: the seeded `hello` plugin, and
    /// the sandbox's `beta` and `plugin-src` folders.
    pub async fn seeded(parts: Parts) -> Self {
        let home = TempHome::new();
        let seed = eos_testkit::fixtures::wire_dir().join("seed/home/plugins/hello/plugin.json");
        home.write("plugins/hello/plugin.json", std::fs::read(seed).expect("the seeded plugin"));
        home.write("sandbox/beta/notes.md", "# Notes\n\n- first\n- second\n");
        // The line `seed/sandbox.sh` writes.
        home.write(
            "sandbox/plugin-src/plugin.json",
            "{ \"id\": \"wire-sample\", \"name\": \"Wire sample\", \"description\": \"Installed from a folder by the wire fixtures.\", \"version\": \"0.1.0\" }\n",
        );
        Self::on(home, parts).await
    }

    pub async fn on(home: TempHome, parts: Parts) -> Self {
        // Real paths, as the app is given: the watcher reports those.
        let root = std::fs::canonicalize(home.path()).expect("the data folder");
        let (dir, data) = (root.join("plugins"), root.join("plugin-data"));
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let kernel = Kernel::new(KernelOptions::default());
        let host = PluginHost::new(PluginHostDeps {
            workspace: Arc::new(FsPluginWorkspace::new(&dir)),
            builder: parts.builder,
            data: Arc::new(FsPluginDataStore::new(&data)),
            fetcher: Arc::new(PluginFetchers::new(parts.registry, "https://registry.test", parts.cloner))
                as Arc<dyn PluginFetcher>,
            staging: Arc::new(FsPluginStaging::new(&dir, Arc::new(RandomIds), clock.clone())),
            records: Arc::new(FsPluginInstallStore::new(&data)),
            previewer: parts.previewer,
            preview_files: Arc::new(TempPreviewFiles),
            clock,
            bus: kernel.bus.clone(),
            builtins: eos_contracts::builtin_plugin_manifests(),
            authoring_plugin: None,
            options: PluginServiceOptions { settle_timeout: parts.settle_timeout, ..PluginServiceOptions::default() },
        });
        let runtime = Runtime::build(kernel, vec![host.module(), Arc::new(PagesStub)], host.switch())
            .expect("the runtime builds");
        runtime.lifecycle.start().await.expect("modules start");
        host.start().await;
        Self { sandbox: root.join("sandbox"), home, host, runtime }
    }

    pub fn root(&self) -> PathBuf {
        std::fs::canonicalize(self.home.path()).expect("the data folder")
    }

    pub fn router(&self) -> Arc<Router> {
        self.runtime.router.clone()
    }

    /// One request as the user's dashboard (`user`) or as any other local page.
    pub async fn call(&self, method: Method, target: &str, body: Option<Value>, user: bool) -> (u16, Value) {
        let (status, _, bytes) = self.raw(method, target, body, user).await;
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    pub async fn raw(
        &self,
        method: Method,
        target: &str,
        body: Option<Value>,
        user: bool,
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let caller = if user { Caller::DASHBOARD } else { Caller::UNTRUSTED };
        self.raw_as(method, target, body, caller).await
    }

    pub async fn raw_as(
        &self,
        method: Method,
        target: &str,
        body: Option<Value>,
        caller: Caller,
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut request = Request::new(method, target, caller);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let response = self.runtime.router.handle(request).await;
        let headers = response.headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
        (response.status, headers, response.body.collect().await.expect("a body").to_vec())
    }
}

pub fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// A gzipped ustar archive of plain files: `(name, mode, body)`.
pub fn tgz(entries: &[(&str, &str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut tar = Vec::new();
    for (name, mode, body) in entries {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..108].copy_from_slice(format!("{mode:0>7}\0").as_bytes());
        header[124..136].copy_from_slice(format!("{:011o}\0", body.len()).as_bytes());
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        tar.extend_from_slice(&header);
        tar.extend_from_slice(body);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.resize(tar.len() + 1024, 0);
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&tar).expect("gzip");
    encoder.finish().expect("gzip")
}
