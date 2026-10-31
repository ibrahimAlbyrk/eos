import { describe, it, expect } from "vitest";
import {
  artifactAgo, accountInitial, artifactInfo, artifactRef, artifactMeta, artifactRowLine, artifactAccountLine,
  artifactTabHead, artifactViewStatus, filterArtifacts, groupByAccount, catalogSyncedAt, placeArtifactPeek, PEEK_W, PEEK_H,
} from "./artifacts.js";

const SLUG = "9e41c7d2-1b3a-4c5d-8e9f-0a1b2c3d4e5f";
const OTHER = "fc8663b5-9f93-4ff4-8a4b-ada56eec16fa";
const NOW = new Date(2026, 9, 29, 14, 0).getTime(); // Thu Oct 29 2026, 14:00 local
const at = (...args) => new Date(...args).getTime();

const row = (over) => ({
  slug: SLUG, url: "https://claude.ai/artifact/LYT7DezY9NMo1GzECapRkz", title: "Eos 0.1.2 release notes",
  kind: "Page", rel: "mine", updatedAt: new Date(NOW - 30_000).toISOString(), loginId: "p", ...over,
});
const accounts = [
  { loginId: "p", label: "Personal", email: "me@example.com", count: 2, refreshedAt: new Date(NOW - 60_000).toISOString() },
  { loginId: "w", label: "Work", email: "me@work.example", count: 1, refreshedAt: new Date(NOW - 5 * 60_000).toISOString() },
];

describe("artifactAgo", () => {
  it("reads like the design: just now, minutes, hours, yesterday, weekday, date", () => {
    expect(artifactAgo(NOW - 20_000, NOW)).toBe("just now");
    expect(artifactAgo(NOW + 5_000, NOW)).toBe("just now");
    expect(artifactAgo(NOW - 4 * 60_000, NOW)).toBe("4 min ago");
    expect(artifactAgo(NOW - 2 * 3600_000, NOW)).toBe("2 h ago");
    expect(artifactAgo(at(2026, 9, 28, 20, 0), NOW)).toBe("yesterday");
    expect(artifactAgo(at(2026, 9, 26, 9, 0), NOW)).toBe("Mon");
    expect(artifactAgo(at(2026, 9, 21, 9, 0), NOW)).toBe("Oct 21");
    expect(artifactAgo(at(2025, 11, 3, 9, 0), NOW)).toBe("Dec 3, 2025");
  });

  it("counts hours across midnight for a few hours, and takes ISO strings", () => {
    const oneAm = at(2026, 9, 29, 1, 0);
    expect(artifactAgo(at(2026, 9, 28, 23, 0), oneAm)).toBe("2 h ago");
    expect(artifactAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe("3 min ago");
    expect(artifactAgo(null, NOW)).toBe("");
  });
});

describe("accountInitial", () => {
  it("takes the label's first letter, else the email's", () => {
    expect(accountInitial({ label: "personal" })).toBe("P");
    expect(accountInitial({ label: "", email: "ibrahim@example.com" })).toBe("I");
    expect(accountInitial({ label: "  · Work" })).toBe("W");
    expect(accountInitial(null)).toBe("?");
  });
});

describe("artifactInfo", () => {
  const catalog = { artifacts: [row({ versionLabel: "v3", tint: "violet", favicon: "📄", version: "3-c" })], accounts };

  it("prefers the catalog over what the opener knew", () => {
    const info = artifactInfo(SLUG, { title: "release-notes", url: "https://claude.ai/code/artifact/" + SLUG, ts: 1 }, catalog);
    expect(info).toMatchObject({
      slug: SLUG, title: "Eos 0.1.2 release notes", kind: "Page", versionLabel: "v3", loginId: "p", tint: "violet", favicon: "📄", known: true,
      url: "https://claude.ai/artifact/LYT7DezY9NMo1GzECapRkz",
    });
    expect(info.account).toEqual({ loginId: "p", label: "Personal", email: "me@example.com", initial: "P", tint: 0 });
    expect(artifactRef(info)).toEqual({ slug: SLUG, loginId: "p", url: info.url, version: "3-c", title: "Eos 0.1.2 release notes" });
  });

  it("falls back to the opener's seed for an artifact the catalog doesn't hold", () => {
    const info = artifactInfo(OTHER, { title: "Shared deck", ts: NOW - 120_000 }, catalog);
    expect(info).toMatchObject({ title: "Shared deck", loginId: null, account: null, known: false, kind: null });
    expect(info.url).toBe("https://claude.ai/artifact/YBc8tWaK41fiYSKdCZ88EM");
    expect(artifactMeta(info, NOW)).toBe("Page · 2 min ago");
    expect(artifactRef(info)).toEqual({ slug: OTHER, loginId: null, url: info.url, title: "Shared deck" });
  });

  it("builds the card meta, row line, peek account line and tab header", () => {
    const info = artifactInfo(SLUG, {}, catalog);
    expect(artifactMeta(info, NOW)).toBe("Page · v3 · just now");
    expect(artifactAccountLine(info, NOW)).toBe("Personal · updated just now");
    expect(artifactTabHead(info, NOW)).toEqual({ chip: "v3", link: info.url.replace("https://", "") });
    expect(artifactTabHead({ ...info, versionLabel: undefined }, NOW).chip).toBe("just now");
    const shared = artifactInfo(SLUG, {}, { accounts, artifacts: [row({ kind: "Doc", rel: "shared" })] });
    expect(artifactRowLine(shared)).toBe("Doc · shared with you");
  });
});

describe("artifactViewStatus", () => {
  it("names the live view's state in the peek footer", () => {
    expect(artifactViewStatus("ready")).toEqual({ tone: "live", label: "Live" });
    expect(artifactViewStatus("signin")).toEqual({ tone: "warn", label: "Sign in to view" });
    expect(artifactViewStatus("error")).toEqual({ tone: "err", label: "Couldn't load" });
    expect(artifactViewStatus("loading")).toEqual({ tone: "loading", label: "Loading" });
    expect(artifactViewStatus("idle")).toEqual({ tone: "loading", label: "Loading" });
  });
});

describe("filterArtifacts", () => {
  const list = [
    row({ slug: "a", title: "Sprint board", loginId: "w" }),
    row({ slug: "b", title: "Onboarding guide", kind: "Doc", rel: "shared", loginId: "w" }),
    row({ slug: "c", title: "Windows plan", kind: "Doc", versionLabel: "draft", loginId: "p" }),
  ];
  const slugs = (xs) => xs.map((a) => a.slug);

  it("matches every word against title, kind and label", () => {
    expect(slugs(filterArtifacts(list, { query: "doc" }))).toEqual(["b", "c"]);
    expect(slugs(filterArtifacts(list, { query: "WINDOWS draft" }))).toEqual(["c"]);
    expect(slugs(filterArtifacts(list, { query: "  " }))).toEqual(["a", "b", "c"]);
  });

  it("narrows by sign-in and by mine / shared", () => {
    expect(slugs(filterArtifacts(list, { loginId: "w" }))).toEqual(["a", "b"]);
    expect(slugs(filterArtifacts(list, { rel: "shared" }))).toEqual(["b"]);
    expect(slugs(filterArtifacts(list, { rel: "mine", loginId: "w" }))).toEqual(["a"]);
  });
});

describe("groupByAccount", () => {
  it("groups in account order and keeps a sign-in whose read failed", () => {
    const failed = [accounts[0], { ...accounts[1], error: "401 Unauthorized" }];
    const groups = groupByAccount([row({ slug: "a", loginId: "p" }), row({ slug: "b", loginId: "gone" })], failed);
    expect(groups.map((g) => [g.account.label, g.tint, g.items.map((i) => i.slug)])).toEqual([
      ["Personal", 0, ["a"]],
      ["Work", 1, []],
      ["Other", null, ["b"]],
    ]);
  });

  it("drops an empty sign-in, and every other one when narrowed", () => {
    expect(groupByAccount([row({ slug: "a", loginId: "p" })], accounts).map((g) => g.account.loginId)).toEqual(["p"]);
    expect(groupByAccount([row({ slug: "a", loginId: "p" })], accounts, { loginId: "w" })).toEqual([]);
  });
});

describe("catalogSyncedAt", () => {
  it("is the oldest sign-in read", () => {
    expect(catalogSyncedAt(accounts)).toBe(NOW - 5 * 60_000);
    expect(catalogSyncedAt([{ loginId: "x", label: "X", count: 0 }])).toBe(null);
  });
});

describe("placeArtifactPeek", () => {
  const anchor = (top, left = 100, height = 54) => ({ top, bottom: top + height, left, height });

  it("opens below the anchor, above when there's no room under it", () => {
    expect(placeArtifactPeek(anchor(100), null, 1280, 800)).toEqual({ side: "below", left: 100, top: 164 });
    expect(placeArtifactPeek(anchor(600), null, 1280, 800)).toEqual({ side: "above", left: 100, top: 600 - 10 - PEEK_H });
  });

  it("keeps inside the window", () => {
    expect(placeArtifactPeek(anchor(100, 1200), null, 1280, 800).left).toBe(1280 - PEEK_W - 8);
  });

  it("goes to the side panel's left beside a row in it, or the usual way without room", () => {
    expect(placeArtifactPeek(anchor(300, 900, 46), 860, 1280, 800)).toEqual({ side: "left", left: 860 - 10 - PEEK_W, top: 323 - PEEK_H / 2 });
    expect(placeArtifactPeek(anchor(300, 400, 46), 380, 1280, 800).side).toBe("below");
  });
});
