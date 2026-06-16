import { describe, it, expect } from "vitest";
import { segment, URL_RE } from "./richText.jsx";

// Render markers as plain objects so the engine can be tested without JSX.
const linkRule = {
  match: URL_RE,
  render: (url) => ({ kind: "link", url }),
};
const labelRule = (labels) => ({
  match: new RegExp(`(${labels.join("|")})`, "g"),
  render: (lbl) => ({ kind: "label", lbl }),
});

describe("segment", () => {
  it("plain text stays a single string node", () => {
    expect(segment("just words", [linkRule])).toEqual(["just words"]);
  });

  it("splits one url into [text, link, text]", () => {
    expect(segment("see https://x.com now", [linkRule])).toEqual([
      "see ",
      { kind: "link", url: "https://x.com" },
      " now",
    ]);
  });

  it("excludes trailing punctuation from the url", () => {
    expect(segment("go to https://x.com.", [linkRule])).toEqual([
      "go to ",
      { kind: "link", url: "https://x.com" },
      ".",
    ]);
    expect(segment("(https://x.com)", [linkRule])).toEqual([
      "(",
      { kind: "link", url: "https://x.com" },
      ")",
    ]);
  });

  it("decorates a url and a label in the same string", () => {
    const out = segment("open https://x.com {image #1}", [
      linkRule,
      labelRule(["{image #1}"]),
    ]);
    expect(out).toEqual([
      "open ",
      { kind: "link", url: "https://x.com" },
      " ",
      { kind: "label", lbl: "{image #1}" },
    ]);
  });

  it("leaves label-less, url-less text untouched", () => {
    expect(segment("hello world", [linkRule, labelRule(["{image #1}"])])).toEqual([
      "hello world",
    ]);
  });

  it("supports scan rules alongside regex rules", () => {
    const scanRule = {
      scan: (t) => (t.startsWith("/cmd") ? [{ start: 0, end: 4 }] : []),
      render: (tok) => ({ kind: "pill", tok }),
    };
    expect(segment("/cmd see https://x.com", [linkRule, scanRule])).toEqual([
      { kind: "pill", tok: "/cmd" },
      " see ",
      { kind: "link", url: "https://x.com" },
    ]);
  });
});

describe("URL_RE", () => {
  it("matches http and https only", () => {
    expect("ftp://x.com".match(URL_RE)).toBeNull();
    expect("http://x.com".match(URL_RE)).toEqual(["http://x.com"]);
  });
});
