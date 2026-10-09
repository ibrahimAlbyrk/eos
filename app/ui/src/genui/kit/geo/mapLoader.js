// MapLibre loads on first use, never at import: it is ~1 MB, it needs WebGL,
// and tests render the static map without it. Its worker is served from the
// bundle (?url) because MapLibre's own default only works from an http(s)
// module URL, and the app loads from eos://.

let loading = null;

export function loadMapLibre() {
  if (!loading) {
    loading = (async () => {
      const [mod, worker] = await Promise.all([
        import("maplibre-gl"),
        import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
        import("maplibre-gl/dist/maplibre-gl.css"),
      ]);
      const ml = mod.default && typeof mod.default.Map === "function" ? mod.default : mod;
      const url = worker?.default;
      if (url && typeof ml.setWorkerUrl === "function") {
        try {
          ml.setWorkerUrl(new URL(url, globalThis.location?.href).href);
        } catch {
          ml.setWorkerUrl(url);
        }
      }
      return ml;
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
