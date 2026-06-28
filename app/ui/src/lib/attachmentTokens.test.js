import { describe, it, expect } from "vitest";
import { makeLabel, labelTitle, findLabelRegions, findLabelAt, clampToTokenBoundary, spliceLabels, labelsDeleted, buildAttachmentSuffix, parseAttachmentMessage, reconcileAttachmentItems } from "./attachmentTokens.js";

describe("makeLabel", () => {
  it("brackets the name, truncating past 24 chars with an ellipsis", () => {
    expect(makeLabel("a.txt")).toBe("[a.txt]");
    expect(makeLabel("123456789012345678901234")).toBe("[123456789012345678901234]");
    expect(makeLabel("screenshot-2026-06-12-at-21.00.png")).toBe("[screenshot-2026-06-12-at…]");
  });

  it("appends the dedupe index past 1", () => {
    expect(makeLabel("a.txt", 2)).toBe("[a.txt 2]");
  });

  it("strips bracket chars and falls back on empty names", () => {
    expect(makeLabel("a[b]c")).toBe("[abc]");
    expect(makeLabel("")).toBe("[file]");
    expect(makeLabel(undefined)).toBe("[file]");
  });
});

describe("labelTitle", () => {
  it("unwraps bracket labels", () => {
    expect(labelTitle("[screensh…]")).toBe("screensh…");
    expect(labelTitle("[a.txt 2]")).toBe("a.txt 2");
  });

  it("keeps the legacy curly form", () => {
    expect(labelTitle("{image #1}")).toBe("Image #1");
    expect(labelTitle("{file #12}")).toBe("File #12");
  });

  it("returns null for non-label strings", () => {
    expect(labelTitle("/tmp/a.png")).toBeNull();
    expect(labelTitle(undefined)).toBeNull();
  });
});

describe("findLabelRegions", () => {
  it("finds every occurrence of every label", () => {
    const text = "a [img.png] b [img.png] [b.txt]";
    expect(findLabelRegions(text, ["[img.png]", "[b.txt]"])).toEqual([
      { start: 2, end: 11 },
      { start: 14, end: 23 },
      { start: 24, end: 31 },
    ]);
  });

  it("returns empty for no matches", () => {
    expect(findLabelRegions("hello", ["[img.png]"])).toEqual([]);
  });
});

describe("findLabelAt", () => {
  const text = "x [img.png] y";
  it("hits inside and at end of token, misses at start boundary", () => {
    expect(findLabelAt(text, 3, ["[img.png]"])).toEqual({ start: 2, end: 11 });
    expect(findLabelAt(text, 11, ["[img.png]"])).toEqual({ start: 2, end: 11 });
    expect(findLabelAt(text, 2, ["[img.png]"])).toBeNull();
    expect(findLabelAt(text, 12, ["[img.png]"])).toBeNull();
  });
});

describe("clampToTokenBoundary", () => {
  const text = "x [img.png] y";
  it("snaps an offset inside a token out to its end", () => {
    expect(clampToTokenBoundary(text, 5, ["[img.png]"])).toBe(11); // inside [img.png]
  });
  it("leaves boundary and outside offsets unchanged", () => {
    expect(clampToTokenBoundary(text, 2, ["[img.png]"])).toBe(2);  // at start
    expect(clampToTokenBoundary(text, 11, ["[img.png]"])).toBe(11); // at end
    expect(clampToTokenBoundary(text, 0, ["[img.png]"])).toBe(0);  // before
    expect(clampToTokenBoundary(text, 13, ["[img.png]"])).toBe(13); // after
  });
});

describe("spliceLabels", () => {
  it("inserts at a clean offset, returning text + trailing caret", () => {
    expect(spliceLabels("hi ", 3, ["[a.png]"], [])).toEqual({ text: "hi [a.png] ", caret: 11 });
  });
  it("clamps off a token interior so it can't split an existing label", () => {
    // caret 2 sits inside [a.png] (0..7); insert must land after it, not inside.
    const r = spliceLabels("[a.png] ", 2, ["[b.png]"], ["[a.png]"]);
    expect(r.text).toBe("[a.png][b.png]  ");
    expect(r.text).toContain("[a.png]");
    expect(r.text).toContain("[b.png]");
  });
});

describe("labelsDeleted", () => {
  it("reports only labels that went present→absent", () => {
    expect(labelsDeleted("[a] [b]", "[a]", ["[a]", "[b]"])).toEqual(["[b]"]);
  });
  it("ignores a freshly inserted label (absent before, present now)", () => {
    expect(labelsDeleted("[a]", "[a] [b]", ["[a]", "[b]"])).toEqual([]);
  });
  it("reports all on a select-all delete", () => {
    expect(labelsDeleted("[a] [b]", "", ["[a]", "[b]"])).toEqual(["[a]", "[b]"]);
  });
});

// The defect this guards: pasting image B used to silently delete image A's chip
// when B's token insert was computed from a stale text snapshot, splitting or
// overwriting A's token so a substring GC dropped it. spliceLabels (live text +
// clamp) + labelsDeleted (present→absent only) are exactly what the intake hook
// runs, so driving them in sequence reproduces the bug and proves the fix.
// Send payload == items.map(label) (Composer.prepareMessage), modeled here as `items`.
describe("paste image A then image B never drops A (regression)", () => {
  function paste(state, label, pos) {
    const items = [...state.items, label];                  // chip appended first
    const { text } = spliceLabels(state.text, pos, [label], state.items);
    const dropped = labelsDeleted(state.text, text, items); // GC after the insert
    return { text, items: items.filter((l) => !dropped.includes(l)) };
  }

  it("caret resting inside the prior token (sync paste path)", () => {
    let s = { text: "", items: [] };
    s = paste(s, "[a.png]", 0);   // → "[a.png] "
    s = paste(s, "[b.png]", 2);   // caret INSIDE [a.png] → clamp to its end
    expect(s.text).toContain("[a.png]");
    expect(s.text).toContain("[b.png]");
    expect(s.items).toEqual(["[a.png]", "[b.png]"]); // both reach the send payload
  });

  it("stale caret offset from the deferred native pasteboard path", () => {
    let s = { text: "", items: [] };
    s = paste(s, "[a.png]", 0);   // A resolves first, inserts at 0
    // B's offset was captured before A existed (0) but B reads the LIVE text now.
    s = paste(s, "[b.png]", 0);
    expect(s.text).toContain("[a.png]");
    expect(s.text).toContain("[b.png]");
    expect(s.items).toEqual(["[a.png]", "[b.png]"]);
  });
});

describe("buildAttachmentSuffix", () => {
  it("builds one mapping line per label, annotating the kind when known", () => {
    const paths = new Map([["[a.png]", "/tmp/a.png"], ["[b.txt]", "/tmp/b.txt"]]);
    const kinds = new Map([["[a.png]", "image"]]);
    expect(buildAttachmentSuffix(["[a.png]", "[b.txt]"], paths, kinds)).toBe(
      "\n\nattachments:\n- [a.png] (image): /tmp/a.png\n- [b.txt]: /tmp/b.txt"
    );
  });

  it("skips labels without a path and returns empty when none resolve", () => {
    const paths = new Map([["[a.png]", null]]);
    expect(buildAttachmentSuffix(["[a.png]"], paths)).toBe("");
    expect(buildAttachmentSuffix([], paths)).toBe("");
  });
});

describe("parseAttachmentMessage", () => {
  it("returns the whole text as display with no attachments when the marker is absent", () => {
    expect(parseAttachmentMessage("just text")).toEqual({ display: "just text", attachments: [] });
    expect(parseAttachmentMessage("")).toEqual({ display: "", attachments: [] });
  });

  it("splits display from a typed attachment list", () => {
    const text = "look [a.png]\n\nattachments:\n- [a.png] (image): /tmp/a.png\n- [b.txt] (file): /tmp/b.txt";
    expect(parseAttachmentMessage(text)).toEqual({
      display: "look [a.png]",
      attachments: [
        { label: "[a.png]", kind: "image", path: "/tmp/a.png" },
        { label: "[b.txt]", kind: "file", path: "/tmp/b.txt" },
      ],
    });
  });

  it("round-trips buildAttachmentSuffix output (writer ↔ reader stay in sync)", () => {
    const paths = new Map([["[a.png]", "/tmp/a.png"], ["[dir]", "/tmp/dir"]]);
    const kinds = new Map([["[a.png]", "image"], ["[dir]", "folder"]]);
    const labels = ["[a.png]", "[dir]"];
    const parsed = parseAttachmentMessage("hi" + buildAttachmentSuffix(labels, paths, kinds));
    expect(parsed.display).toBe("hi");
    expect(parsed.attachments).toEqual([
      { label: "[a.png]", kind: "image", path: "/tmp/a.png" },
      { label: "[dir]", kind: "folder", path: "/tmp/dir" },
    ]);
  });

  it("infers kind from the extension when the annotation is missing", () => {
    const text = "x\n\nattachments:\n- [a.png]: /tmp/a.png\n- [b.txt]: /tmp/b.txt";
    expect(parseAttachmentMessage(text).attachments).toEqual([
      { label: "[a.png]", kind: "image", path: "/tmp/a.png" },
      { label: "[b.txt]", kind: "file", path: "/tmp/b.txt" },
    ]);
  });

  it("tolerates the legacy curly-label and bare forms", () => {
    const text = "x\n\nattachments:\n- {image #1}: /tmp/a.png\n- folder: /tmp/dir";
    expect(parseAttachmentMessage(text).attachments).toEqual([
      { label: "{image #1}", kind: "image", path: "/tmp/a.png" },
      { kind: "folder", path: "/tmp/dir" },
    ]);
  });
});

describe("reconcileAttachmentItems", () => {
  // refs as seen by useAttachments: every minted label survives remove/clear.
  const refs = {
    usedLabels: new Set(["[a.txt]", "[b.png]"]),
    paths: new Map([["[a.txt]", "/tmp/a.txt"], ["[b.png]", "/tmp/b.png"]]),
    kinds: new Map([["[a.txt]", "file"], ["[b.png]", "image"]]),
    pending: new Map(),
  };

  it("re-seats a removed chip when undo brings its label back", () => {
    const next = reconcileAttachmentItems([], "see [a.txt] please", refs);
    expect(next).toEqual([{ label: "[a.txt]", kind: "file", path: "/tmp/a.txt", status: "ready" }]);
  });

  it("drops a chip whose label the restored text no longer holds", () => {
    const prev = [{ label: "[a.txt]", kind: "file", path: "/tmp/a.txt", status: "ready" }];
    expect(reconcileAttachmentItems(prev, "nothing here", refs)).toEqual([]);
  });

  it("keeps surviving chips and appends regained ones", () => {
    const prev = [{ label: "[a.txt]", kind: "file", path: "/tmp/a.txt", status: "ready" }];
    const next = reconcileAttachmentItems(prev, "[a.txt] and [b.png]", refs);
    expect(next.map((it) => it.label)).toEqual(["[a.txt]", "[b.png]"]);
  });

  it("returns the same array reference when nothing changes (setItems no-op)", () => {
    const prev = [{ label: "[a.txt]", kind: "file", path: "/tmp/a.txt", status: "ready" }];
    expect(reconcileAttachmentItems(prev, "[a.txt] only", refs)).toBe(prev);
  });

  it("re-seats an in-flight upload as uploading, skips a label with neither path nor job", () => {
    const r = {
      usedLabels: new Set(["[up.png]", "[dead.txt]"]),
      paths: new Map(),
      kinds: new Map([["[up.png]", "image"]]),
      pending: new Map([["[up.png]", Promise.resolve()]]),
    };
    const next = reconcileAttachmentItems([], "[up.png] [dead.txt]", r);
    expect(next).toEqual([{ label: "[up.png]", kind: "image", path: null, status: "uploading" }]);
  });
});
