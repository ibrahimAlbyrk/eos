import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { UiProvider } from "../../state/ui.jsx";
import { fixtureTransport, setEosTransport } from "../../state/eos/transport.js";
import { probeEosStatus } from "../../state/eos/eosStatusStore.js";
import { EosView } from "./EosView.jsx";

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

beforeEach(async () => {
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
  it("draws Eos's empty frame inside the app's chrome", () => {
    const html = renderToStaticMarkup(<UiProvider><EosView live={{ workers: [] }} /></UiProvider>);
    expect(html).toContain('<span class="eos-switch__mark">Eos</span>');
    expect(html).toContain('<nav class="sb-nav" aria-label="Eos"></nav>');
    expect(html).toContain('<section class="center"><main></main></section>');
  });
});
