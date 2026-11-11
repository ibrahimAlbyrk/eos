// The bridge script (crates/eos-bridge/src/bridge.js) run against a fake page: what it
// defines, what it sends to the shell, how it routes the shell's events.
//   usage: node tests/bridge_script_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "crates", "eos-bridge", "src", "bridge.js"), "utf8");

// A page with just enough of a browser for the script.
function page({ seed = null, stored = {}, answers = {} } = {}) {
  const sent = [];
  const storage = new Map(Object.entries(stored));
  const handlers = { window: {}, document: {} };
  const classes = new Set();
  let source_ = null;
  const element = { classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) }, dataset: {} };
  const window = {
    addEventListener: (name, f) => { handlers.window[name] = f; },
  };
  const context = vm.createContext({
    window,
    document: { documentElement: element, addEventListener: (name, f) => { handlers.document[name] = f; }, querySelector: () => null },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ path: url.replace("/_shell/", ""), body, token: init.headers["x-eos-ui-token"] });
      return { json: async () => ({ value: answers[url.replace("/_shell/", "")] ?? null }) };
    },
    EventSource: class { constructor(url) { this.url = url; source_ = this; } },
    setInterval: () => 0, clearInterval: () => {}, performance: { now: () => 0 },
    getComputedStyle: (el) => ({ getPropertyValue: () => el.region ?? "" }),
    Element: Object, TextEncoder, btoa, Date, JSON, String, Array, Object, Map, Set, Promise, encodeURIComponent,
  });
  const cfg = { coreUrl: "http://eos.localhost/_core", rawUrl: "http://raw.eos.localhost", uiToken: "tok", seed, seedMarker: "eos:migratedFromElectron" };
  vm.runInContext(source.replace("__CFG__", JSON.stringify(cfg)), context);
  const emit = (name, payload) => source_.onmessage({ data: JSON.stringify({ name, payload }) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { window, sent, storage, handlers, classes, element, emit, settle, events: () => source_ };
}

// ---- what the dashboard reads at boot
{
  const p = page();
  assert.equal(p.window.__EOS_DAEMON_URL, "http://eos.localhost/_core");
  assert.equal(p.window.__EOS_RAW_URL, "http://raw.eos.localhost");
  assert.equal(p.window.__EOS_UI_TOKEN, "tok");
  assert.ok(p.classes.has("native"));
  assert.equal(p.element.dataset.os, "mac");
  assert.equal(p.events().url, "/_shell/events?t=tok");
  assert.equal(p.window.eosArtifacts, undefined, "artifact views come later: the dashboard takes its own fallback");
  assert.equal(p.window.eosTransfer, undefined);
  for (const name of ["themeChanged", "themeSnapshot", "saveFile", "pasteboardPaths", "titlebarDrag", "titlebarDblClick"]) {
    assert.equal(typeof p.window.webkit.messageHandlers[name].postMessage, "function", name);
  }
  assert.equal(p.sent.length, 0, "nothing is sent without a reason");
}

// ---- the storage carry-over: once, before anything else, and reported
{
  const p = page({ seed: { "cm:theme": "light", "cm:draft": "ğüş 😀" } });
  assert.equal(p.storage.get("cm:theme"), "light");
  assert.equal(p.storage.get("cm:draft"), "ğüş 😀");
  assert.ok(p.storage.has("eos:migratedFromElectron"));
  assert.deepEqual(p.sent[0], { path: "migration/done", body: { keys: 2 }, token: "tok" });
  // The marker is already there (the shell lost its own): nothing is overwritten.
  const again = page({ seed: { "cm:theme": "light" }, stored: { "eos:migratedFromElectron": "1", "cm:theme": "dark" } });
  assert.equal(again.storage.get("cm:theme"), "dark");
  assert.deepEqual(again.sent[0].body, { keys: 0 });
}

// ---- the browser panel: every report is sequenced, in order
{
  const p = page();
  const v = p.window.eosBrowserView;
  v.setActiveView({ sessionKey: "s", tabId: "t" });
  v.setBounds({ x: 1, y: 2, width: 3, height: 4, extra: "dropped" });
  v.setVisible(1);
  v.overlayOpen(0);
  v.setOccluded(true);
  const [active, bounds, visible, overlay, occluded] = p.sent;
  assert.deepEqual({ ...active.body, seq: 0 }, { seq: 0, sessionKey: "s", tabId: "t" });
  assert.deepEqual({ ...bounds.body, seq: 0 }, { seq: 0, x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual([visible.path, visible.body.value, overlay.path, overlay.body.value, occluded.path, occluded.body.value], ["browserView/setVisible", true, "browserView/overlay", false, "browserView/occluded", true]);
  const seqs = p.sent.map((s) => s.body.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, 5);
  assert.ok(seqs[0] > 1e12, "starts from the clock, so a reload continues the order");
}

// ---- events: fanned out by name; one that comes before its listener waits for it
{
  const p = page();
  p.emit("hosts:command", { type: "connect", invite: "eos://pair/x" });
  const got = [];
  p.window.eosHosts.onCommand((c) => got.push(c));
  assert.deepEqual(got, [{ type: "connect", invite: "eos://pair/x" }], "delivered when the dashboard registers");
  p.emit("hosts:command", { type: "connect" });
  assert.equal(got.length, 2);
  const off = p.window.eosHosts.onChange(() => got.push("changed"));
  off();
  p.emit("hosts:changed", {});
  assert.equal(got.length, 2, "an unsubscribed listener hears nothing");
  p.emit("window:fullscreen", { on: true });
  assert.ok(p.classes.has("fullscreen"));
  p.emit("window:fullscreen", { on: false });
  assert.ok(!p.classes.has("fullscreen"));
  p.events().onmessage({ data: "not json" });
}

// ---- a banner click opens a view or a worker
{
  const p = page();
  const opened = [];
  p.window.__nativeOpenRoute = (r) => opened.push("route:" + r);
  p.window.__nativeNavigate = (w) => opened.push("worker:" + w);
  p.emit("navigate", { route: "memory" });
  p.emit("navigate", { workerId: "w-1" });
  assert.deepEqual(opened, ["route:memory", "worker:w-1"]);
}

// ---- the Edit menu
{
  const p = page({ answers: { "clipboard/read": { text: "é☃", hasFiles: false } } });
  const calls = [];
  p.window.__eosUndo = () => calls.push("undo");
  p.emit("edit", { command: "undo" });
  p.emit("edit", { command: "redo" });
  await p.settle();
  assert.deepEqual(calls, ["undo"], "undo belongs to the composer's stack");
  assert.deepEqual(p.sent.map((s) => [s.path, s.body]), [["edit", { command: "redo" }]], "no stack for redo: the native command");

  // No terminal focused: the native commands.
  p.sent.length = 0;
  for (const command of ["copy", "paste", "selectAll"]) p.emit("edit", { command });
  await p.settle();
  assert.deepEqual(p.sent.map((s) => s.body.command), ["copy", "paste", "selectAll"]);

  // A focused terminal copies its selection and takes pasted text itself.
  p.sent.length = 0;
  const term = [];
  p.window.__eosTerm = { getSelectionIfFocused: () => "ls -la", isFocused: () => true, pasteBase64: (b) => term.push(["paste", b]), selectAll: () => term.push(["selectAll"]) };
  for (const command of ["copy", "cut", "paste", "selectAll"]) p.emit("edit", { command });
  await p.settle();
  await p.settle();
  assert.deepEqual(p.sent.map((s) => s.path), ["clipboard/write", "clipboard/write", "clipboard/read"]);
  assert.deepEqual(p.sent[0].body, { text: "ls -la" });
  assert.deepEqual(term, [["selectAll"], ["paste", Buffer.from("é☃", "utf8").toString("base64")]]);

  // Files on the clipboard take the page's own paste, even in a terminal.
  const files = page({ answers: { "clipboard/read": { text: null, hasFiles: true } } });
  files.window.__eosTerm = { isFocused: () => true, pasteBase64: () => assert.fail("must not paste text") };
  files.emit("edit", { command: "paste" });
  await files.settle();
  await files.settle();
  assert.deepEqual(files.sent.map((s) => s.path), ["clipboard/read", "edit"]);
}

// ---- window drag: only a press on a drag strip, never in the transcript or the sidebar
{
  const p = page();
  const press = (target, detail = 1, button = 0) => p.handlers.window.mousedown({ button, detail, target });
  const strip = { region: "drag", closest: () => null };
  press(strip);
  press(strip, 2);
  press({ region: "no-drag", closest: () => null });
  press({ region: "drag", closest: () => ({}) });
  press(strip, 1, 2);
  press(strip, 3);
  assert.deepEqual(p.sent.map((s) => s.path), ["window/startDragging", "window/toggleZoom"]);
  let prevented = 0;
  p.handlers.window.contextmenu({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1, "the system's context menu never opens");
}

// ---- a Finder drop: the shell reads the paths of the parked File objects
{
  const p = page({ answers: { "files/dropped": [{ path: "/tmp/a.png", isDir: false }] } });
  const dropped = [];
  p.window.__eosNativeDrop = (entries) => dropped.push(entries);
  const drag = (types, files) => ({ dataTransfer: { types, files }, prevented: 0, preventDefault() { this.prevented++; } });
  const text = drag(["text/plain"], []);
  p.handlers.document.drop(text);
  assert.equal(text.prevented + p.sent.length, 0, "a text drag is the page's own business");
  const file = drag(["Files"], [{ name: "a.png" }]);
  p.handlers.document.dragover(file);
  p.handlers.document.drop(file);
  assert.equal(file.prevented, 2);
  assert.equal(p.window.__eosDroppedFiles.length, 1);
  await p.settle();
  await p.settle();
  assert.deepEqual(dropped, [[{ path: "/tmp/a.png", isDir: false }]]);
  assert.equal(p.window.__eosDroppedFiles, null, "the File objects are not kept");
}

// ---- theme, save, notify
{
  const p = page({ answers: { "theme/snapshot": "data:image/jpeg;base64,AAAA", "clipboard/paths": null } });
  const frames = [];
  p.window.__eosThemeSnapshot = (url) => frames.push(url);
  p.window.webkit.messageHandlers.themeChanged.postMessage("light");
  p.window.webkit.messageHandlers.themeSnapshot.postMessage();
  p.window.webkit.messageHandlers.saveFile.postMessage({ filename: "a.txt", base64: "aGk=", mimeType: "text/plain" });
  p.window.eosNotify.show({ title: "T", body: "B", secret: "dropped" });
  assert.equal(JSON.stringify(await p.window.webkit.messageHandlers.pasteboardPaths.postMessage()), "[]", "no paths is an empty list");
  await p.settle();
  assert.deepEqual(frames, ["data:image/jpeg;base64,AAAA"]);
  assert.deepEqual(p.sent.map((s) => [s.path, s.body]).slice(0, 4), [
    ["theme/changed", { theme: "light" }],
    ["theme/snapshot", null],
    ["files/save", { filename: "a.txt", base64: "aGk=" }],
    ["notify", { title: "T", body: "B" }],
  ]);
  assert.ok(p.sent.every((s) => s.token === "tok"), "every call carries the ui-token");
}
console.log("bridge script: 9 groups ok");
