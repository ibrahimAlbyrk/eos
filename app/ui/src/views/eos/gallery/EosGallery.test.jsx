import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { transport, setEosTransport } from "../../../state/eos/transport.js";
import { eosLocation, openLocation, _resetEosNav } from "../nav/eosNav.js";
import routines from "./sample/routines.json";
import { EosGallery, galleryTransport, playTransition, SLOW_K, startEosGallery } from "./EosGallery.jsx";
import { GALLERY_STATE_KEY, GALLERY_STATES, stateOf } from "./states.js";
import { parseLocation } from "../nav/eosNav.js";
import { _resetField, useField } from "../field/fieldStore.js";
import { ENTER_MS } from "../field/transition.js";
import paper from "./sample/paper.json";
import decision from "./sample/surface-decision.json";
import { holdNetwork } from "./holdNetwork.js";
import { aboutYouReads } from "./sample/about-you.js";

const rendered = [];
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: (element) => rendered.push(element) }),
}));

// The app's UI context the gallery draws in reads the window's storage.
beforeEach(() => {
  const kept = new Map();
  vi.stubGlobal("localStorage", { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) });
});
afterEach(() => {
  setEosTransport(null);
  _resetEosNav();
  vi.unstubAllGlobals();
  rendered.length = 0;
});

describe("#eos-gallery", () => {
  it("draws Eos at its start, Home, from the samples without calling the core", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    startEosGallery({});

    expect(rendered).toHaveLength(1);
    const html = renderToStaticMarkup(rendered[0]);
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<nav class="sb-nav" aria-label="Eos">');
    expect(html).toContain('<button class="sb-nav-row strong on"><span class="sb-nav-row__ic">');
    expect(html).toContain('<section class="center"><main class="eos-screen eos-home">');

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

  it("holds a state of every screen, each at an Eos location, the reads answering from the samples", async () => {
    const ids = GALLERY_STATES.map((st) => st.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const st of GALLERY_STATES) expect(parseLocation(st.location), st.id).not.toBeNull();
    const screens = new Set(GALLERY_STATES.map((st) => parseLocation(st.location).screen));
    for (const screen of ["home", "needs", "need", "routines", "routine", "new-routine", "run", "memory", "capabilities", "surface"]) expect(screens).toContain(screen);
    const candidate = galleryTransport(stateOf("page-candidate"));
    expect((await candidate.get(ROUTES.surface(paper.surface.id))).body.candidateVersion).toBe(3);
    expect((await galleryTransport(stateOf("home-error")).get(ROUTES.routines)).status).toBe(500);
    let answered = false;
    void galleryTransport(stateOf("home-loading")).get(ROUTES.routines).then(() => { answered = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBe(false);
  });

  it("draws a View that asks in Needs you, first in the list, inside the app's UI context", async () => {
    const reads = galleryTransport(stateOf("need-view"));
    expect(stateOf("need-view").location).toBe(`eos:/needs/${decision.item.id}`);
    expect((await reads.get(ROUTES.inbox)).body.items[0].id).toBe(decision.item.id);
    expect((await reads.get(ROUTES.inboxItem(decision.item.id))).body.item.view).toEqual(decision.item.view);
    expect((await reads.get(ROUTES.surfaceIssue(decision.surface.id, decision.issue.id))).body.body.view.title).toBe("Mail Triage needs two answers");
    vi.stubGlobal("fetch", vi.fn());
    startEosGallery({});
    expect(renderToStaticMarkup(rendered[0])).toContain('<div class="app eos-mode">');
  });

  it("says PR Review's schedule last and next ran on weekdays at 05:00 around now", async () => {
    const id = routines.find((r) => r.name === "PR Review")?.id ?? routines[0].id;
    const [sc] = (await galleryTransport(stateOf("routine")).get(ROUTES.signalsRoutine(id))).body.schedules;
    for (const at of [sc.nextAt, sc.lastAt]) {
      const d = new Date(at);
      expect([d.getHours(), d.getMinutes()]).toEqual([5, 0]);
      expect([0, 6]).not.toContain(d.getDay());
    }
    expect(sc.lastAt).toBeLessThanOrEqual(Date.now());
    expect(sc.nextAt).toBeGreaterThan(Date.now());
  });

  it("draws a reconnecting state: each read answers once from the samples, then hears nothing", async () => {
    const reads = galleryTransport(stateOf("home-offline"));
    expect((await reads.get(ROUTES.routines)).body).toEqual(routines);
    await expect(reads.get(ROUTES.routines)).rejects.toThrow();
    await expect(reads.send("POST", ROUTES.routines, {})).rejects.toThrow();
    expect(stateOf("need-offline").location).toBe(stateOf("need").location);
  });

  it("keeps the app's own requests on the page: each is refused and no stream opens", async () => {
    const page = {};
    holdNetwork(page);
    const answer = await page.fetch("http://127.0.0.1:7400/api/settings");
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: "the gallery calls no core" });
    expect(new page.EventSource("http://127.0.0.1:7400/stream").readyState).toBe(2);
  });

  it("answers the app's memory reads from a sample, so About you draws, and refuses a write to them", async () => {
    const page = {};
    holdNetwork(page, aboutYouReads(Date.now()));
    const read = await page.fetch("http://127.0.0.1:7400/api/user-memories");
    expect(read.status).toBe(200);
    const { memories } = await read.json();
    expect(memories.some((m) => m.status === "suggested")).toBe(true);
    expect(memories.some((m) => m.scope.kind === "project")).toBe(true);
    expect((await page.fetch("http://127.0.0.1:7400/api/user-memories", { method: "POST", body: "{}" })).status).toBe(503);
  });

  it("hands About you in, as the app does", () => {
    vi.stubGlobal("sessionStorage", { getItem: (k) => (k === GALLERY_STATE_KEY ? "memory-about" : null), setItem: () => {} });
    startEosGallery({});
    const html = renderToStaticMarkup(rendered[0]);
    expect(html).toContain(">Add memory</button>");
    expect(html).not.toContain("About you shows in the app.");
  });

  it("opens in the state picked last, and offers the states, Play and Slow", () => {
    vi.stubGlobal("sessionStorage", { getItem: (k) => (k === GALLERY_STATE_KEY ? "page-reshape" : null), setItem: () => {} });
    vi.stubGlobal("fetch", vi.fn());
    startEosGallery({});
    expect(eosLocation()).toBe(`eos:/surfaces/${paper.surface.id}?mode=reshape`);
    const html = renderToStaticMarkup(rendered[0]);
    expect(html).toContain('role="toolbar" aria-label="Gallery"');
    expect(html).toContain('<option value="page-reshape" selected="">Page · changing it</option>');
    expect(html).toContain('<button type="button" class="eos-gallery-bar__play">Play</button>');
    expect(html).toContain("Slow");
  });

  it("Play opens the field and leaves it again, Slow at 2.8 times the timings", () => {
    vi.useFakeTimers();
    _resetField();
    let field;
    const Probe = () => { field = useField(); return null; };
    playTransition(SLOW_K);
    renderToStaticMarkup(<Probe />);
    expect(field.phase).toBe("entering");
    vi.advanceTimersByTime(ENTER_MS * SLOW_K - 1);
    renderToStaticMarkup(<Probe />);
    expect(field.phase).toBe("entering");
    vi.advanceTimersByTime(1);
    renderToStaticMarkup(<Probe />);
    expect(field.phase).toBe("field");
    vi.advanceTimersByTime(700);
    renderToStaticMarkup(<Probe />);
    expect(field.phase).toBe("leaving");
    playTransition(1);
    _resetField();
    vi.useRealTimers();
  });
});
