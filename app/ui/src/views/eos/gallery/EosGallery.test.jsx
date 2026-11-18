import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { transport, setEosTransport } from "../../../state/eos/transport.js";
import routinesOne from "./sample/routines-one.json";
import { startEosGallery } from "./EosGallery.jsx";

const rendered = [];
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: (element) => rendered.push(element) }),
}));

afterEach(() => {
  setEosTransport(null);
  vi.unstubAllGlobals();
  rendered.length = 0;
});

describe("#eos-gallery", () => {
  it("draws an empty Eos frame from the samples without calling the core", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    startEosGallery({});

    expect(rendered).toHaveLength(1);
    const html = renderToStaticMarkup(rendered[0]);
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<nav class="sb-nav" aria-label="Eos"></nav>');
    expect(html).toContain('<section class="center"><main class="eos-screen">');

    expect(await transport.get(ROUTES.routines)).toEqual({ ok: true, status: 200, body: routinesOne });
    expect((await transport.send("POST", ROUTES.routines, {})).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
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
