// The gallery's states of a routine's App: PR Review's changelog preview
// as a tool in the whole window, before its first version is kept, read
// slowly, and in the side panel beside a screen (Apps on or switched off).
import { ROUTES } from "../../../api/routes.js";
import routines from "./sample/routines.json";

// PR Review keeps it from the pull requests it reviews (Release Notes is still
// being made, so it has nothing yet).
const RT = routines.find((r) => r.name === "PR Review")?.id ?? routines[0].id;
export const APP = "sf-changelog01";
// Its second version was kept today at 13:50, the first yesterday.
const KEPT = new Date().setHours(13, 50, 0, 0);
const surface = {
  id: APP, routineId: RT, level: "app", place: "routine_page", role: "app", title: "Changelog preview",
  currentVersion: 2, createdAt: KEPT - 24 * 60 * 60 * 1000, updatedAt: KEPT,
};
// The App's own page: what it draws is its own design, inside the sandbox.
const HTML = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;background:#f7f6f2;color:#1d1d1b}
main{padding:28px 32px}h1{font:600 22px/1.2 Georgia,serif;margin:0 0 4px}p.sub{margin:0 0 20px;color:#6b6a65}
section{border-top:1px solid #dddbd3;padding:14px 0}h2{font:600 12px/1 system-ui;letter-spacing:.08em;text-transform:uppercase;color:#8a5a1c;margin:0 0 8px}
li{margin:4px 0}
</style><main><h1>v2.4, drafted</h1><p class="sub">Eleven pull requests since v2.3 · three need a line from you</p>
<section><h2>Added</h2><ul><li>Shop carousel pages by touch and by keys (#470)</li><li>Haptics on combos (#466)</li></ul></section>
<section><h2>Fixed</h2><ul><li>The loader no longer stalls on a cold start (#468)</li><li>Tile pooling leaked on scene change (#465)</li></ul></section>
<section><h2>Changed</h2><ul><li>The SDK moves to 11.2 (#464)</li></ul></section>
</main>`;
const version = {
  meta: { version: 2, status: "kept", madeBy: "builder", note: "", bodyBytes: HTML.length, createdAt: KEPT },
  body: { html: HTML, manifest: { title: "Changelog preview", summary: "The next release's notes, grouped as they will ship.", height: 520, uses: [], queries: [] } },
  checks: {},
  accessLine: "This App can read the merged pull requests of acme/game and post to #releases after you say yes.",
};

const withApp = (s) => ({
  ...s,
  [ROUTES.surface(APP)]: surface,
  [`${ROUTES.surfaceIssues(APP)}?limit=20`]: { issues: [], more: false },
  [ROUTES.surfaceVersion(APP, 2)]: version,
});
const notYet = (s) => ({ ...withApp(s), [ROUTES.surface(APP)]: { ...surface, currentVersion: null } });
const AT = `eos:/surfaces/${APP}`;

export const APP_STATES = [
  { id: "app", label: "App · as a tool", location: AT, reads: withApp },
  { id: "app-none", label: "App · no version kept yet", location: AT, reads: notYet },
  { id: "app-loading", label: "App · loading", location: AT, answer: "loading" },
  { id: "app-panel", label: "App · in the side panel", location: "eos:/routines", reads: withApp, panel: { surfaceId: APP } },
  { id: "app-panel-none", label: "App · in the side panel, no version kept yet", location: "eos:/routines", reads: notYet, panel: { surfaceId: APP } },
  { id: "app-panel-off", label: "App · in the side panel, Apps switched off", location: "eos:/routines", reads: withApp, panel: { surfaceId: APP, appsOff: true } },
];
