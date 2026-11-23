import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetHomeDraft, HOME_DRAFT_KEY, setHomeDraft } from "../../../state/eos/homeDraftStore.js";
import { fixtureTransport, setEosTransport, transport } from "../../../state/eos/transport.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { ROUTES } from "../../../api/routes.js";
import routines from "../gallery/sample/routines.json";
import { HomeInput } from "./HomeInput.jsx";
import { ThingChips } from "./ThingChips.jsx";
import { attachmentsOf, isLink, LONG_TEXT, linkThing, pathThing, textThing, uploadThing } from "./things.js";

function stubStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetHomeDraft();
});
afterEach(() => setEosTransport(null));

describe("things handed to the Home input", () => {
  it("names each by kind, and only ready ones reach the core", () => {
    const things = [
      pathThing("1", { path: "/Users/a/notes/level-design.pdf" }),
      pathThing("2", { path: "/Users/a/notes/", isDir: true }),
      pathThing("3", { path: "/Users/a/shot.png" }),
      linkThing("4", " https://github.com/acme/game/pull/482 "),
      textThing("5", "x".repeat(1240)),
      uploadThing("6", "draft.txt", "file"),
    ];
    expect(things.map((t) => [t.kind, t.label])).toEqual([
      ["file", "level-design.pdf"], ["folder", "notes"], ["image", "shot.png"],
      ["link", "github.com/acme/game/pull/482"], ["text", "Pasted text, 1,240 characters"], ["file", "draft.txt"],
    ]);
    expect(attachmentsOf(things).map((a) => a.kind)).toEqual(["file", "folder", "image", "link", "text"]);
    expect(attachmentsOf(things)[3]).toEqual({ kind: "link", value: "https://github.com/acme/game/pull/482" });
  });

  it("tells a lone link from text, and long text from typing", () => {
    expect(isLink("https://example.com/a")).toBe(true);
    expect(isLink("see https://example.com/a")).toBe(false);
    expect(LONG_TEXT).toBe(500);
  });

  it("draws a chip per thing with a way to remove it, and says when one is still being added", () => {
    const html = renderToStaticMarkup(<ThingChips things={[linkThing("1", "https://a.b/c"), uploadThing("2", "x.txt", "file")]} onRemove={() => {}} />);
    expect(html).toContain('aria-label="Remove a.b/c"');
    expect(html).toContain('<li class="eos-thing eos-thing--uploading">');
    expect(html).toContain("(adding)");
  });

  it("refuses uploads from sample data", async () => {
    setEosTransport(fixtureTransport({}));
    expect((await transport.upload(new Blob(["x"]))).status).toBe(403);
  });
});

describe("the Home input", () => {
  it("is never focused on its own, keeps what was typed, and sends nothing until Enter has a meaning", () => {
    globalThis.localStorage = stubStorage({ [HOME_DRAFT_KEY]: "review 482" });
    _resetHomeDraft();
    const html = renderToStaticMarkup(<HomeInput />);
    expect(html).not.toContain("autofocus");
    expect(html).toContain('placeholder="What should Eos take care of?"');
    expect(html).toContain('value="review 482"');
    expect(html).toContain('aria-label="Attach"');
    setHomeDraft("");
    expect(renderToStaticMarkup(<HomeInput />)).toContain('aria-label="Send" disabled=""');
  });

  it("is filled by a starter chip and cleared with it", () => {
    setHomeDraft("Watch my inbox");
    expect(globalThis.localStorage.data.get(HOME_DRAFT_KEY)).toBe("Watch my inbox");
    expect(renderToStaticMarkup(<HomeInput />)).toContain('aria-label="Send">');
    setHomeDraft("");
    expect(globalThis.localStorage.data.has(HOME_DRAFT_KEY)).toBe(false);
  });

  it("says under the card what Enter will do, from the user's routines", async () => {
    const pr = { ...routines[0], takes: { ...routines[0].takes, itemPatterns: ["(?:^|\\s)#(\\d+)\\b"] } };
    setEosTransport(fixtureTransport({ [ROUTES.routines]: [pr] }));
    _resetRoutines();
    await refreshRoutines();
    setHomeDraft("review #470");
    const html = renderToStaticMarkup(<HomeInput />);
    expect(html).toContain("Run PR Review on #470, draft for you");
    expect(html).toContain("Tab for other choices");
    expect(html).toContain('aria-label="Send">');
    setHomeDraft("");
    expect(renderToStaticMarkup(<HomeInput />)).toContain("Click a routine around the input, drop a file on one, or just type.");
    _resetRoutines();
  });
});
