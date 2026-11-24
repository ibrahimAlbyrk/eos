import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setEosTransport } from "../../../state/eos/transport.js";
import { HomeInput } from "../input/HomeInput.jsx";
import { doorOf, heldThings } from "./held.js";
import { OfferCard, offerShown } from "./LoginOffer.jsx";
import { QuickPanel, WIDTH } from "./QuickPanel.jsx";

afterEach(() => setEosTransport(null));

const shortcut = {
  source: "shortcut",
  app: "Safari",
  parts: [
    { kind: "text", text: "Shader variant stripping cuts the build by a third, with the numbers below" },
    { kind: "url", url: "https://example.com/shaders" },
    { kind: "file", path: "/Users/me/build-report-1182.txt" },
    { kind: "folder", path: "/Users/me/game/" },
  ],
};

describe("what a door holds for the quick panel", () => {
  it("becomes the Home input's things, the selection saying where it came from", () => {
    const things = heldThings(shortcut);
    expect(things.map((t) => [t.kind, t.label])).toEqual([
      ["text", "From Safari: Shader variant stripping cuts the build by a th…"],
      ["link", "example.com/shaders"],
      ["file", "build-report-1182.txt"],
      ["folder", "game"],
    ]);
    expect(things[0].value).toBe(shortcut.parts[0].text);
    expect(things.every((t) => t.status === "ready")).toBe(true);
    expect(heldThings({ source: "link", app: null, parts: [{ kind: "text", text: "hi" }] })[0].label).toBe("hi");
    expect(heldThings(null)).toEqual([]);
  });

  it("starts through the door that brought it, the shortcut when the panel opened empty", () => {
    expect(doorOf(shortcut)).toBe("shortcut");
    expect(doorOf({ source: "dock", parts: [] })).toBe("dock");
    expect(doorOf(null)).toBe("shortcut");
  });

  it("shows in the input as chips before the text", () => {
    const html = renderToStaticMarkup(<HomeInput held={heldThings(shortcut)} door="shortcut" />);
    expect(html).toContain("From Safari: Shader variant");
    expect(html).toContain("build-report-1182.txt");
  });

  it("draws the panel folded small around the input", () => {
    const html = renderToStaticMarkup(<QuickPanel doors={null} />);
    expect(html).toContain(`class="eos-quick" style="width:${WIDTH}px"`);
    expect(html).toContain("What should Eos take care of?");
  });
});

describe("the one-time Start-at-login offer", () => {
  it("shows only while it is off and was never answered, and only where the app can start at login", () => {
    expect(offerShown({ available: true, state: "off", offered: false })).toBe(true);
    expect(offerShown({ available: true, state: "off", offered: true })).toBe(false);
    expect(offerShown({ available: true, state: "on", offered: false })).toBe(false);
    expect(offerShown({ available: false, state: "off", offered: false })).toBe(false);
    expect(offerShown(null)).toBe(false);
  });

  it("asks in one sentence, with both answers", () => {
    const html = renderToStaticMarkup(<OfferCard onChoose={() => {}} />);
    expect(html).toContain("Start Eos at login?");
    expect(html).toContain(">Not now</button>");
    expect(html).toContain(">Start at login</button>");
  });
});
