import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { transport, setEosTransport } from "../../../state/eos/transport.js";
import { eosLocation, openLocation, _resetEosNav } from "../nav/eosNav.js";
import routines from "./sample/routines.json";
import { startEosGallery } from "./EosGallery.jsx";

const rendered = [];
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: (element) => rendered.push(element) }),
}));

afterEach(() => {
  setEosTransport(null);
  _resetEosNav();
  vi.unstubAllGlobals();
  rendered.length = 0;
});

describe("#eos-gallery", () => {
  it("draws Eos at its start, Needs you, from the samples without calling the core", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    startEosGallery({});

    expect(rendered).toHaveLength(1);
    const html = renderToStaticMarkup(rendered[0]);
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<nav class="sb-nav" aria-label="Eos">');
    expect(html).toContain('<button class="sb-nav-row strong on"><span class="sb-nav-row__ic">');
    expect(html).toContain('<section class="center"><main class="eos-screen">');
    expect(html).toContain('<h1 class="eos-title">Needs you</h1>');

    expect(await transport.get(ROUTES.routines)).toEqual({ ok: true, status: 200, body: routines });
    const rows = (await transport.get(ROUTES.capabilities)).body;
    expect(rows.map((r) => r.state)).toEqual(["needs_setup", "ready", "needs_sign_in", "degraded", "broken", "disabled"]);
    expect(rows[0]).not.toHaveProperty("actions");
    for (const row of rows) expect((await transport.get(ROUTES.capability(row.id))).body).toMatchObject(row);
    expect((await transport.get(ROUTES.capabilitySignIn("github"))).body).toEqual({ state: "failed" });
    expect((await transport.send("POST", ROUTES.routines, {})).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens at its start and leaves where the user's own Eos opens untouched", () => {
    const stored = new Map([["eos:location", "eos:/capabilities/github"]]);
    vi.stubGlobal("localStorage", { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) });

    startEosGallery({});
    expect(eosLocation()).toBe("eos:/");
    openLocation("eos:/needs");
    expect(eosLocation()).toBe("eos:/needs");
    expect(stored.get("eos:location")).toBe("eos:/capabilities/github");
  });

  // index.html's inline boot-snapshot script runs before main.jsx picks the page.
  it("asks for no boot snapshot before the bundle loads", () => {
    const html = readFileSync(new URL("../../../../index.html", import.meta.url), "utf8");
    const boot = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("/api/boot"));
    const runOn = (hash) => {
      const fetchMock = vi.fn(() => Promise.resolve({ ok: false }));
      const page = { __EOS_DAEMON_URL: "http://core" };
      new Function("window", "location", "localStorage", "fetch", boot)(page, { hash }, { getItem: () => null }, fetchMock);
      return fetchMock;
    };

    expect(runOn("")).toHaveBeenCalledWith("http://core/api/boot", { headers: {} });
    expect(runOn("#eos-gallery")).not.toHaveBeenCalled();
  });
});
