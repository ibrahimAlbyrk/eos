import { describe, it, expect } from "vitest";
import { ROUTES as webRoutes } from "./routes.js";
import clientSrc from "./client.js?raw";

// The table's keys and paths against the core's own table are checked on the Rust
// side (`cargo xtask` test `generated_routes_js_matches_the_dashboards_file`).

describe("web ROUTES", () => {
  // The mirror is deliberately partial (the core's table has more), but a
  // ROUTES.x referenced by client.js that's missing here resolves to undefined
  // and dies as a silent unhandled rejection inside the async api fns. Catch
  // that drift at test time.
  it("every ROUTES key referenced by client.js exists in the web table", () => {
    const used = [...clientSrc.matchAll(/ROUTES\.(\w+)/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((key) => !(key in webRoutes));
    expect(missing).toEqual([]);
  });

  // The archive feature's frozen contract, asserted explicitly.
  it("archive endpoints match the frozen backend contract", () => {
    expect(webRoutes.workersArchived).toBe("/workers/archived");
    expect(webRoutes.workerArchive("w1")).toBe("/workers/w1/archive");
    expect(webRoutes.workerRestore("w1")).toBe("/workers/w1/restore");
    expect(webRoutes.workerPurge("w1")).toBe("/workers/w1/purge");
    expect(webRoutes.settingsArchive).toBe("/api/settings/archive");
  });

  it("visual answers routes match the core's table", () => {
    expect(webRoutes.genuiView("v_abcdefghijkl")).toBe("/api/genui/views/v_abcdefghijkl");
    expect(webRoutes.genuiViewState("v_abcdefghijkl")).toBe("/api/genui/views/v_abcdefghijkl/state");
    expect(webRoutes.settingsGenui).toBe("/api/settings/genui");
    expect(webRoutes.genuiViews).toBe("/api/genui/views");
    expect(webRoutes.genuiApps).toBe("/api/genui/apps");
  });
});
