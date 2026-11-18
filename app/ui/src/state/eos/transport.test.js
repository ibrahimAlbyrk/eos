import { describe, it, expect, vi, afterEach } from "vitest";
import { transport, setEosTransport, fixtureTransport } from "./transport.js";
import { ROUTES } from "../../api/routes.js";
import routinesOne from "../../views/eos/gallery/sample/routines-one.json";
import routinesEmpty from "../../views/eos/gallery/sample/routines-empty.json";

const answer = (status, body) => vi.fn().mockResolvedValue({ ok: status < 300, status, json: async () => body });

afterEach(() => {
  setEosTransport(null);
  vi.unstubAllGlobals();
});

describe("the core transport", () => {
  it("reads with the ui token and hands back the envelope, a 404 included", async () => {
    const fetchMock = answer(404, { error: "not found", path: ROUTES.routines });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { __EOS_UI_TOKEN: "tok" });

    const r = await transport.get(ROUTES.routines);

    expect(r).toEqual({ ok: false, status: 404, body: { error: "not found", path: ROUTES.routines } });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url.endsWith(ROUTES.routines)).toBe(true);
    expect(opts.headers).toEqual({ "x-eos-ui-token": "tok" });
  });

  it("sends a JSON body with the ui token, and none when there is none", async () => {
    const fetchMock = answer(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { __EOS_UI_TOKEN: "tok" });

    await transport.send("POST", "/api/x", { a: 1 });
    await transport.send("DELETE", "/api/x/1");

    const [, post] = fetchMock.mock.calls[0];
    expect(post.method).toBe("POST");
    expect(post.headers).toEqual({ "content-type": "application/json", "x-eos-ui-token": "tok" });
    expect(JSON.parse(post.body)).toEqual({ a: 1 });
    const [, del] = fetchMock.mock.calls[1];
    expect(del).toEqual({ method: "DELETE", headers: { "x-eos-ui-token": "tok" }, body: undefined });
  });
});

describe("the fixture transport", () => {
  it("answers reads from the samples and never calls the core", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setEosTransport(fixtureTransport({ [ROUTES.routines]: routinesOne }));

    expect(await transport.get(ROUTES.routines)).toEqual({ ok: true, status: 200, body: routinesOne });
    expect(await transport.get(ROUTES.routine("rt-x"))).toEqual({
      ok: false, status: 404, body: { error: "not found", path: ROUTES.routine("rt-x") },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses every write as sample data", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setEosTransport(fixtureTransport({}));

    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(await transport.send(method, ROUTES.routines, { name: "x" }))
        .toEqual({ ok: false, status: 403, body: { error: "sample data" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives way to the core again when it is taken out", async () => {
    const fetchMock = answer(200, routinesOne);
    vi.stubGlobal("fetch", fetchMock);
    setEosTransport(fixtureTransport({ [ROUTES.routines]: routinesEmpty }));
    expect(await transport.get(ROUTES.routines)).toEqual({ ok: true, status: 200, body: [] });

    setEosTransport(null);
    expect(await transport.get(ROUTES.routines)).toEqual({ ok: true, status: 200, body: routinesOne });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
