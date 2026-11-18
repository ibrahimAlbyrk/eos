import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { UiProvider } from "../../state/ui.jsx";
import { fixtureTransport, setEosTransport } from "../../state/eos/transport.js";
import { probeEosStatus } from "../../state/eos/eosStatusStore.js";
import { eosLocation, openLocation, _resetEosNav } from "./nav/eosNav.js";
import { EosView } from "./EosView.jsx";

// The bindings the drawn views register, as the keymap would hold them.
const bindings = vi.hoisted(() => []);
vi.mock("../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: (b) => { bindings.push(b); } }));

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

const draw = () => renderToStaticMarkup(<UiProvider><EosView live={{ workers: [] }} /></UiProvider>);

// A key on a Mac → whether a binding took it.
function press(code, { ctrl = false } = {}) {
  const e = { metaKey: true, ctrlKey: ctrl, altKey: false, shiftKey: false, key: "", code, preventDefault: vi.fn() };
  const binding = bindings.find((b) => b.match(e));
  binding?.run({}, e);
  return Boolean(binding);
}

beforeEach(async () => {
  bindings.length = 0;
  _resetEosNav();
  globalThis.localStorage = stubStorage();
  localStorage.setItem("cm:activeView", "eos");
  setEosTransport(fixtureTransport({ [ROUTES.routines]: [] }));
  await probeEosStatus();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("EosView", () => {
  it("draws Eos's frame inside the app's chrome, at the remembered place", () => {
    localStorage.setItem("eos:location", "eos:/memory");
    const html = draw();
    expect(html).toContain('<span class="eos-switch__mark">Eos</span>');
    expect(html).toContain('<nav class="sb-nav" aria-label="Eos"></nav>');
    expect(html).toContain('<section class="center"><main class="eos-screen">');
    expect(html).toContain('<h1 class="eos-title">Memory</h1>');
  });

  it("goes back with ⌘[ and forward with ⌘]", () => {
    draw();
    openLocation("eos:/needs");
    openLocation("eos:/memory");
    expect(press("BracketLeft")).toBe(true);
    expect(eosLocation()).toBe("eos:/needs");
    expect(press("BracketRight")).toBe(true);
    expect(eosLocation()).toBe("eos:/memory");
    expect(press("BracketLeft", { ctrl: true })).toBe(false);
  });
});
