import { describe, it, expect, vi, afterEach } from "vitest";
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
    expect(html).toContain('<section class="center"><main></main></section>');

    expect(await transport.get(ROUTES.routines)).toEqual({ ok: true, status: 200, body: routinesOne });
    expect((await transport.send("POST", ROUTES.routines, {})).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
