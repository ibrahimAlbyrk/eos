// Handler runs for generate.mjs: a tool, its input, and the daemon's scripted
// answers in the order the handler asks for them ({ status?, body }).

const user = { kind: "user", agentId: null, name: null };
const agent = (agentId, name = null) => ({ kind: "agent", agentId, name });
const page = (over = {}) => ({
  id: "pg-3f9a1c2b7d10", title: "Release notes", body: "- [ ] ship\n- [x] test\n", project: "/repo/app", agentId: "w-self0001",
  rev: 4, createdAt: 1800000000000, updatedAt: 1800000123456, updatedBy: user, ...over,
});
const summary = (over = {}) => {
  const { body: _body, ...rest } = page(over);
  return { ...rest, excerpt: "ship · test", tasks: { open: 1, done: 1 }, ...over };
};
const memory = (over = {}) => ({
  id: "um-0123456789ab", text: "Prefers pnpm over npm.", category: "stack", scope: { kind: "global" }, tier: "always",
  status: "active", source: { kind: "user" }, rev: 1, createdAt: 1800000000000, updatedAt: 1800000000000, ...over,
});
const plugin = (over = {}) => ({
  id: "clock", builtin: false, dir: "/home/u/.eos/plugins/clock", manifest: { id: "clock", name: "Clock" }, enabled: true,
  state: "active", error: null, rev: 3, hasUi: true, hasCss: false, settings: { seconds: true, zone: "utc", size: 2 }, ...over,
});
const transfer = (over = {}) => ({
  id: "tr-0123456789ab", from: "local", to: "a".repeat(64), origin: { kind: "agent", agentId: "w-self0001", agentName: "chat" },
  sources: ["/repo/app/dist", "/repo/app/notes.md"], destDir: "/Users/u/Downloads/Eos", destReason: "default", status: "copying",
  error: null, roots: [{ name: "dist", type: "dir", size: 5_000_000, mtimeMs: 1800000000000 }, { name: "notes.md", type: "file", size: 900, mtimeMs: 1800000000000 }],
  fileCount: 12, totalBytes: 5_000_900, doneBytes: 1_250_000, rate: 0, route: "direct", conflicts: [], decisions: {}, placed: [],
  createdAt: 1800000000000, startedAt: 1800000000100, finishedAt: null, ...over,
});
const stats = (collections) => ({ uiBytes: 300, dataBytes: 900, elements: 7, depth: 3, components: ["List", "Map"], collections, images: 0, sites: 0, maps: 1, primaryActions: 0 });
const place = (name, lat, lon) => ({ type: "Place", id: name.toLowerCase().replace(/\W+/g, "-"), name, geo: [lat, lon], address: "Moda Cd. 1" });
const question = { question: "Ship it?", header: "Release", options: [{ label: "Yes" }, { label: "No", description: "Wait a day" }] };
const T0 = 1800000000000;

export const HANDLER_CASES = [
  // ---- pages ------------------------------------------------------------------
  { tool: "list_pages", name: "this project", args: {}, api: [{ body: { pages: [summary(), summary({ id: "pg-aaaaaaaaaaaa", title: "", updatedBy: agent("w-self0001", "me") }), summary({ id: "pg-bbbbbbbbbbbb", title: "Plan", updatedBy: agent("w-other001", "planner"), excerpt: "" }), summary({ id: "pg-cccccccccccc", updatedBy: agent("w-other002") }), summary({ id: "pg-dddddddddddd", updatedBy: agent(null) })] } }] },
  { tool: "list_pages", name: "every project, filtered", args: { query: "plan & ship", all: true }, api: [{ body: { pages: [summary({ project: null }), summary({ id: "pg-bbbbbbbbbbbb", project: "/repo/other" })] } }] },
  { tool: "list_pages", name: "none", args: { query: "" }, api: [{ body: { pages: [] } }] },
  { tool: "read_page", name: "edited by the user", args: { id: "pg-3f9a1c2b7d10" }, api: [{ body: { page: page() } }] },
  { tool: "read_page", name: "untitled, edited by the reader", args: { id: "pg-3f9a1c2b7d10" }, api: [{ body: { page: page({ title: "", body: "", updatedBy: agent("w-self0001", "me") }) } }] },
  { tool: "read_page", name: "edited by a named agent", args: { id: "pg-3f9a1c2b7d10" }, api: [{ body: { page: page({ updatedBy: agent("w-other001", "planner"), updatedAt: 1 }) } }] },
  { tool: "read_page", name: "unknown", args: { id: "pg-000000000000" }, api: [{ status: 404, body: { error: "page not found: pg-000000000000" } }] },
  { tool: "create_page", name: "created", args: { title: "Notes" }, api: [{ status: 201, body: { page: page({ title: "Notes", body: "", rev: 1 }) } }] },
  { tool: "create_page", name: "refused", args: { title: "Notes", body: "x" }, api: [{ status: 400, body: { error: "this chat has no project folder" } }] },
  { tool: "append_to_page", name: "at the end", args: { id: "pg-3f9a1c2b7d10", text: "- [ ] more" }, api: [{ body: { page: page({ rev: 5 }) } }] },
  { tool: "append_to_page", name: "under a heading", args: { id: "pg-3f9a1c2b7d10", text: "line", under_heading: "Later" }, api: [{ body: { page: page({ rev: 6 }) } }] },
  { tool: "edit_page", name: "replaced", args: { id: "pg-3f9a1c2b7d10", old_text: "ship", new_text: "" }, api: [{ body: { page: page({ rev: 7 }) } }] },
  { tool: "edit_page", name: "passage not unique", args: { id: "pg-3f9a1c2b7d10", old_text: "t", new_text: "T" }, api: [{ status: 409, body: { error: "old_text occurs 3 times — include more of the surrounding text" } }] },
  { tool: "set_page_task", name: "ticked", args: { id: "pg-3f9a1c2b7d10", task: "ship" }, api: [{ body: { page: page({ rev: 8 }) } }] },
  { tool: "set_page_task", name: "unticked", args: { id: "pg-3f9a1c2b7d10", task: "test", done: false }, api: [{ body: { page: page({ rev: 9 }) } }] },

  // ---- memory -----------------------------------------------------------------
  { tool: "search_memory", name: "matches", args: { query: "pnpm" }, api: [{ body: { memories: [memory(), memory({ id: "um-bbbbbbbbbbbb", text: "Tests run with vitest.", scope: { kind: "project", path: "/repo/app" } })] } }] },
  { tool: "search_memory", name: "nothing", args: { query: "", limit: 3 }, api: [{ body: { memories: [] } }] },
  { tool: "search_memory", name: "withheld", args: { query: "x" }, api: [{ status: 403, body: { error: "the user doesn't share their profile with this provider" } }] },
  { tool: "suggest_memory", name: "suggested", args: { text: "Prefers tabs.", category: "work-style", scope: "global", why: "said so" }, api: [{ status: 201, body: { memory: memory({ status: "suggested" }), duplicate: false, declined: false } }] },
  { tool: "suggest_memory", name: "already known", args: { text: "Prefers pnpm over npm.", category: "stack", scope: "project" }, api: [{ body: { memory: memory(), duplicate: true, declined: false } }] },
  { tool: "suggest_memory", name: "declined before", args: { text: "Likes emoji.", category: "other", scope: "global" }, api: [{ body: { memory: memory({ status: "dismissed" }), duplicate: true, declined: true } }] },
  { tool: "suggest_memory", name: "too many waiting", args: { text: "x", category: "about", scope: "global" }, api: [{ status: 429, body: { error: "too many suggestions are waiting for review" } }] },

  // ---- plugins ----------------------------------------------------------------
  { tool: "plugin_status", name: "every plugin", args: {}, api: [{ body: { plugins: [plugin(), plugin({ id: "broken", manifest: null, state: "error", error: "plugin.json: Unexpected token" })], dir: "/home/u/.eos/plugins" } }] },
  { tool: "plugin_status", name: "loaded", args: { id: "clock" }, api: [{ body: { plugin: plugin(), report: { rev: 3, ok: true, at: T0 } } }] },
  { tool: "plugin_status", name: "failed in the window", args: { id: "clock" }, api: [{ body: { plugin: plugin(), report: { rev: 3, ok: false, error: "ReferenceError: x is not defined", at: 1 } } }] },
  { tool: "plugin_status", name: "failed without a reason", args: { id: "clock" }, api: [{ body: { plugin: plugin(), report: { rev: 4, ok: false, at: 1 } } }] },
  { tool: "plugin_status", name: "an older build is loaded", args: { id: "clock" }, api: [{ body: { plugin: plugin(), report: { rev: 2, ok: true, at: 1 } } }] },
  { tool: "plugin_status", name: "no window", args: { id: "clock" }, api: [{ body: { plugin: plugin(), report: null } }] },
  { tool: "plugin_status", name: "turned off", args: { id: "clock" }, api: [{ body: { plugin: plugin({ enabled: false, state: "disabled" }), report: null } }] },
  { tool: "plugin_status", name: "no ui, never built", args: { id: "clock" }, api: [{ body: { plugin: plugin({ hasUi: false, rev: 0, settings: {} }), report: null } }] },
  { tool: "plugin_status", name: "build error", args: { id: "clock" }, api: [{ body: { plugin: plugin({ state: "error", error: "index.jsx:3:1: Unexpected \"}\"", rev: 0 }), report: null } }] },
  { tool: "plugin_status", name: "no such folder", args: { id: "nope" }, api: [{ status: 404, body: { error: "plugin not found: nope" } }] },
  { tool: "plugin_preview", name: "drawn", args: { id: "clock", surface: "header", width: 400 }, api: [{ body: { path: "/tmp/eos-previews/clock-header-1.png", build: 3, surface: "header", view: null, width: 400, height: 56, errors: [], available: { main: [], panel: ["clock"], header: ["clock"] } } }] },
  { tool: "plugin_preview", name: "request out of range", args: { id: "clock", width: 10, waitMs: 9000, store: { "bad key": 1 }, view: "v" } },
  { tool: "plugin_preview", name: "not drawable", args: { id: "clock" }, api: [{ status: 409, body: { error: "can't preview \"clock\": it is turned off" } }] },

  // ---- control ----------------------------------------------------------------
  { tool: "spawn_worker", name: "in a repository", selfId: "o-orch01", args: { prompt: "Fix the parser", name: "fix-parser", model: "sonnet", effort: "high", collaborate: true, from: "explorer", toolsAllow: ["Read"], toolsDeny: ["Bash"], editRegex: "(^|/)src/" }, api: [{ status: 201, body: { id: "w-new00001", port: 0, isolation: "worktree" } }] },
  { tool: "spawn_worker", name: "outside a repository", selfId: "o-orch01", gitRepo: false, cwd: "/tmp/scratch", args: { prompt: "Look around", collaborate: false }, api: [{ status: 201, body: { id: "w-new00002", port: 0, isolation: "cwd" } }] },
  { tool: "spawn_worker", name: "in a worker's worktree", selfId: "o-orch01", args: { prompt: "Review it", workspaceOf: "w-new00001" }, api: [{ status: 201, body: { id: "w-new00003", port: 0, isolation: "worktree" } }] },
  { tool: "spawn_worker", name: "unknown definition", selfId: "o-orch01", args: { prompt: "x", from: "nope" }, api: [{ status: 400, body: { error: "unknown worker definition: nope" } }] },
  { tool: "kill_worker", name: "removed", selfId: "o-orch01", args: { id: "w-new00001" }, api: [{ body: { killed: [], removed: true, was_state: "IDLE", id: "w-new00001", name: "fix-parser" } }] },
  { tool: "kill_worker", name: "someone else's", selfId: "o-orch01", args: { id: "w-other001" }, api: [{ status: 403, body: { error: "worker w-other001 is not managed by o-orch01" } }] },
  { tool: "message_worker", name: "delivered", selfId: "o-orch01", args: { id: "w-new00001", text: "Also run the tests." }, api: [{ body: { ok: true, id: "w-new00001", name: "fix-parser" } }] },
  { tool: "message_worker", name: "archived", selfId: "o-orch01", args: { id: "w-new00001", text: "hi" }, api: [{ status: 409, body: { error: "worker is archived — restore first" } }] },
  { tool: "integrate_workers", name: "merged", selfId: "o-orch01", args: {}, api: [{ body: { ok: true, checkout: "/repo/app", branch: "eos-integration-o-orch01", workers: [{ workerId: "w-new00001", name: "fix-parser", branch: "eos-fix-parser", outcome: "merged", files: ["src/a.ts"] }, { workerId: "w-new00002", name: null, branch: null, outcome: "skipped", files: [], reason: "no branch" }], mergedFiles: ["src/a.ts"], conflictedFiles: [], message: "Merged 1 branch." } }] },
  { tool: "integrate_workers", name: "some", selfId: "o-orch01", args: { ids: ["w-new00001"] }, api: [{ body: { ok: false, checkout: "/repo/app", branch: null, workers: [], mergedFiles: [], conflictedFiles: [], message: "Nothing to integrate." } }] },
  { tool: "send_message_to_parent", name: "delivered", args: { text: "result: done" }, api: [{ body: { ok: true, delivered: true } }] },
  { tool: "send_message_to_parent", name: "no parent", args: { text: "result: done" }, api: [{ status: 400, body: { error: "worker has no parent" } }] },

  // ---- the user ---------------------------------------------------------------
  { tool: "notify_user", name: "sent", selfId: "o-orch01", args: { title: "Task complete", body: "Review ready." }, api: [{ body: { ok: true } }] },
  { tool: "ask_user", name: "answered", selfId: "o-orch01", args: { questions: [question] }, api: [{ body: { questionId: "p-00000001", toolUseId: "p-00000002" } }, { body: { status: "pending" } }, { body: { status: "answered", answers: { "Ship it?": "Yes" } } }] },
  { tool: "ask_user", name: "dismissed", selfId: "o-orch01", args: { questions: [question] }, api: [{ body: { questionId: "p-00000001", toolUseId: "p-00000002" } }, { body: { status: "dismissed" } }] },

  // ---- peers ------------------------------------------------------------------
  { tool: "list_peers", name: "some", args: {}, api: [{ body: [{ id: "w-peer0001", name: "auth-expert", state: "IDLE", summary: "Owns the auth module" }, { id: "w-peer0002", name: null, state: "WORKING", summary: "" }] }] },
  { tool: "list_peers", name: "none yet", args: {}, api: [{ body: [] }] },
  { tool: "ask_peer", name: "answered", args: { peerId: "w-peer0001", question: "Where is the token refreshed?" }, api: [{ body: { requestId: "r-00000001" } }, { body: { status: "pending" } }, { body: { status: "answered", answer: "In auth/refresh.ts." } }] },
  { tool: "ask_peer", name: "by name, declined", args: { peerName: "auth-expert", question: "?" }, api: [{ body: { requestId: "r-00000001" } }, { body: { status: "declined", reason: "the peer is waiting on you" } }] },
  { tool: "ask_peer", name: "declined without a reason", args: { peerName: "auth-expert", question: "?" }, api: [{ body: { requestId: "r-00000001" } }, { body: { status: "declined" } }] },
  { tool: "ask_peer", name: "gone", args: { peerId: "w-peer0001", question: "?" }, api: [{ body: { requestId: "r-00000001" } }, { body: { status: "gone" } }] },
  { tool: "ask_peer", name: "not sent", args: { peerId: "w-peer0009", question: "?" }, api: [{ body: { declined: true, reason: "w-peer0009 is not one of your peers." } }] },
  { tool: "ask_peer", name: "not sent, no reason", args: { peerId: "w-peer0009", question: "?" }, api: [{ body: { declined: true } }] },
  { tool: "ask_peer", name: "no target", args: { question: "?" } },
  { tool: "respond_to_peer", name: "delivered", args: { answer: "In auth/refresh.ts." }, api: [{ body: { ok: true, outcome: "answered", toWorker: "w-asker001", toName: "impl" } }] },
  { tool: "respond_to_peer", name: "delivered to a nameless asker", args: { answer: "x" }, api: [{ body: { ok: true, outcome: "answered", toWorker: "w-asker001", toName: null } }] },
  { tool: "respond_to_peer", name: "nobody waiting", args: { answer: "x" }, api: [{ body: { ok: true, outcome: "none" } }] },

  // ---- browser ----------------------------------------------------------------
  { tool: "browser_snapshot", name: "the active tab", args: {}, api: [{ body: { tabId: "tab-1" } }, { body: { tabId: "tab-1", url: "https://example.com/", snapshot: "- button \"OK\" @e1" } }] },
  { tool: "browser_navigate", name: "a named tab", args: { tabId: "tab-2", action: "url", url: "https://example.com" }, api: [{ body: { ok: true, tabId: "tab-2", url: "https://example.com/" } }] },
  { tool: "browser_act", name: "no active tab", args: { ref: "@e1", verb: "click" }, api: [{ status: 409, body: { error: "no active tab" } }] },
  { tool: "browser_get", name: "refused", args: { tabId: "tab-9", what: "url" }, api: [{ status: 404, body: { error: "tab not found" } }] },
  { tool: "browser_tabs", name: "listed", args: {}, api: [{ body: { tabs: [], sessionId: "o-orch01" } }] },
  { tool: "browser_close_tab", name: "the active tab", args: {}, api: [{ body: { tabId: "tab-1" } }, { body: { ok: true } }] },
  { tool: "browser_screenshot", name: "a file", args: { tabId: "tab-1", fullPage: true }, api: [{ body: { path: "/tmp/eos-shots/tab-1.jpg" } }] },
  { tool: "browser_show", name: "shown", args: {}, api: [{ body: { ok: true, tabId: "tab-1" } }] },

  // ---- visual answers -----------------------------------------------------------
  { tool: "present", name: "rendered", selfId: "o-orch01", args: { title: "Cafes", ui: "<List of=\"places\"/>", summary: "Six cafes" }, api: [{ status: 201, body: { viewId: "v_AbCdEfGhIjKl", warnings: [], stats: stats([{ name: "sources", count: 9, type: null }, { name: "places", count: 6, type: "Place" }]) } }] },
  { tool: "present", name: "rendered with warnings", selfId: "o-orch01", args: { title: "Cafes", ui: "<Text>hi</Text>", summary: "s" }, api: [{ status: 201, body: { viewId: "v_AbCdEfGhIjKl", warnings: [{ path: "ui.Text[0]", message: "unknown attr \"colour\"" }], stats: stats([]) } }] },
  { tool: "present", name: "rejected", selfId: "o-orch01", args: { title: "Cafes", ui: "<Nope/>", summary: "s" }, api: [{ status: 400, body: { error: "2 problems — nothing rendered", problems: [{ path: "ui.Nope[0]", message: "unknown component" }, { path: "summary", message: "too long" }] } }] },
  { tool: "present", name: "one problem", selfId: "o-orch01", args: { title: "Cafes", ui: "<Nope/>", summary: "s" }, api: [{ status: 400, body: { error: "1 problem", problems: [{ path: "ui", message: "empty" }] } }] },
  { tool: "present", name: "switched off", selfId: "o-orch01", args: { title: "t", ui: "u", summary: "s" }, api: [{ status: 403, body: { error: "Visual answers are off — answer in text" } }] },
  { tool: "present", name: "not a presenter", args: { title: "t", ui: "u", summary: "s" }, api: [{ status: 403, body: { error: "only an orchestrator or a focused session can present — report to your orchestrator instead" } }] },
  { tool: "present_app", name: "rendered", selfId: "o-orch01", args: { title: "Timer", html: "<!doctype html><p>x</p>", summary: "A timer" }, api: [{ status: 201, body: { viewId: "v_AbCdEfGhIjKl", warnings: [] } }] },
  { tool: "present_app", name: "rendered with warnings", selfId: "o-orch01", args: { title: "Timer", html: "<p>x</p>", summary: "A timer", height: 900 }, api: [{ status: 201, body: { viewId: "v_AbCdEfGhIjKl", warnings: [{ path: "height", message: "clamped to 720" }] } }] },
  { tool: "present_app", name: "rejected", selfId: "o-orch01", args: { title: "Timer", html: "", summary: "s" }, api: [{ status: 400, body: { error: "1 problem", problems: [{ path: "html", message: "empty" }] } }] },
  { tool: "find_places", name: "near a named place", selfId: "o-orch01", args: { query: "  ramen ", near: { text: " Kadıköy " }, radiusM: 2500.4, limit: 3 }, api: [{ body: { places: [place("Menya", 40.99, 29.02), place("Ramen Ya", 40.98, 29.03)], attribution: "© OpenStreetMap contributors", center: { lat: 40.99, lon: 29.03, label: "Kadıköy, İstanbul" }, radiusM: 2500 } }] },
  { tool: "find_places", name: "near the user", selfId: "o-orch01", args: { category: "cafe" }, api: [{ body: { lat: 41.0, lon: 29.0, accuracy: 35.4, at: T0, area: { district: "Moda", city: "İstanbul", country: "Türkiye" } } }, { body: { places: [place("Moda Kahve", 41.0, 29.0)], attribution: "© OpenStreetMap contributors", center: { lat: 41.0, lon: 29.0 }, radiusM: 1500 } }] },
  { tool: "find_places", name: "near a point, nothing found", selfId: "o-orch01", args: { query: "sauna", category: "spa", near: { lat: 41, lon: 29 }, radiusM: 20 }, api: [{ body: { places: [], attribution: "© OpenStreetMap contributors", center: { lat: 41, lon: 29 }, radiusM: 50 } }] },
  { tool: "find_places", name: "near a string", selfId: "o-orch01", args: { category: "bar", near: "Galata", radiusM: 1000 }, api: [{ body: { places: [place("Bar", 41.02, 28.97)], attribution: "© OpenStreetMap contributors", center: { lat: 41.02, lon: 28.97 }, radiusM: 1000 } }] },
  { tool: "find_places", name: "location sharing off", selfId: "o-orch01", args: { category: "cafe" }, api: [{ status: 403, body: { error: "Location sharing is off. The user can turn it on in Settings › Visual answers.", code: "off" } }] },
  { tool: "find_places", name: "no query", selfId: "o-orch01", args: { query: "   " } },
  { tool: "find_places", name: "bad point", selfId: "o-orch01", args: { category: "cafe", near: { lat: 141, lon: 29 } } },
  { tool: "find_places", name: "unknown place", selfId: "o-orch01", args: { category: "cafe", near: { text: "Atlantis" } }, api: [{ status: 404, body: { error: "No place named \"Atlantis\" was found — try another spelling or a nearby city." } }] },
  { tool: "current_location", name: "with an area", selfId: "o-orch01", now: T0 + 9 * 60_000, args: {}, api: [{ body: { lat: 41.0, lon: 29.0, accuracy: 35.4, at: T0, area: { district: "Moda", city: "İstanbul", country: "Türkiye" } } }] },
  { tool: "current_location", name: "just now, no area, coarse", selfId: "o-orch01", now: T0 + 20_000, args: {}, api: [{ body: { lat: 41.123456, lon: 29.5, accuracy: 2449.9, at: T0 } }] },
  { tool: "current_location", name: "hours old, very coarse", selfId: "o-orch01", now: T0 + 150 * 60_000, args: {}, api: [{ body: { lat: 41, lon: 29, accuracy: 12500, at: T0, area: { city: "İstanbul", country: "İstanbul" } } }] },
  { tool: "current_location", name: "sub-metre", selfId: "o-orch01", now: T0 + 61 * 60_000, args: {}, api: [{ body: { lat: 41, lon: 29, accuracy: 0.2, at: T0, area: {} } }] },
  { tool: "current_location", name: "refused", selfId: "o-orch01", now: T0, args: {}, api: [{ status: 403, body: { error: "Location sharing is off. The user can turn it on in Settings › Visual answers.", code: "off" } }] },

  // ---- transfer ---------------------------------------------------------------
  { tool: "send_to_machine", name: "done after a read", now: T0, args: { machine: "MacBook Air", paths: ["dist", "/repo/app/notes.md"] }, api: [{ status: 201, body: transfer({ status: "queued", roots: [], totalBytes: 0, doneBytes: 0 }) }, { body: transfer({ status: "done", doneBytes: 5_000_900, placed: [{ name: "dist", path: "/Users/u/Downloads/Eos/dist" }, { name: "notes.md", path: "/Users/u/Downloads/Eos/notes 2.md" }] }) }] },
  { tool: "send_to_machine", name: "small file, done at once", now: T0, args: { machine: "Mini", paths: ["a.txt"] }, api: [{ status: 201, body: transfer({ status: "done", sources: ["/repo/app/a.txt"], roots: [{ name: "a.txt", type: "file", size: 900, mtimeMs: 1 }], totalBytes: 900, doneBytes: 900, placed: [{ name: "a.txt", path: "/Users/u/Downloads/Eos/a.txt" }] }) }] },
  // The clock moves with every look at it: the call gives up following after a minute.
  { tool: "send_to_machine", name: "still copying after a minute", now: T0, tick: 1499, args: { machine: "Mini", paths: ["dist"] }, api: [{ status: 201, body: transfer() }, ...Array.from({ length: 40 }, () => ({ body: transfer({ doneBytes: 1_250_000 }) }))] },
  { tool: "send_to_machine", name: "paused", now: T0, args: { machine: "Mini", paths: ["dist"] }, api: [{ status: 201, body: transfer() }, { body: transfer({ status: "paused" }) }] },
  { tool: "send_to_machine", name: "cancelled before the scan", now: T0, args: { machine: "Mini", paths: ["dist"] }, api: [{ status: 201, body: transfer({ roots: [] }) }, { body: transfer({ status: "cancelled", roots: [] }) }] },
  { tool: "send_to_machine", name: "failed after a blip", now: T0, args: { machine: "Mini", paths: ["dist"] }, api: [{ status: 201, body: transfer() }, { status: 502, body: { error: "blip" } }, { body: transfer({ status: "failed", error: { code: "io", message: "the disk is full" } }) }] },
  { tool: "send_to_machine", name: "failed without a reason", now: T0, args: { machine: "Mini", paths: ["dist"] }, api: [{ status: 201, body: transfer({ status: "failed" }) }] },
  { tool: "send_to_machine", name: "no such machine", now: T0, args: { machine: "Nope", paths: ["dist"] }, api: [{ status: 400, body: { error: "invalid request: No paired Mac matches \"Nope\" — paired: MacBook Air, Mini" } }] },
];
