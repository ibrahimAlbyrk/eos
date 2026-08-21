import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAttachmentMessage,
  buildAttachmentSuffix,
  kindFromExt,
  ChatAttachmentSchema,
} from "../attachments.ts";

describe("kindFromExt", () => {
  it("maps image extensions to image, everything else to file", () => {
    assert.equal(kindFromExt("/a/b.png"), "image");
    assert.equal(kindFromExt("/a/B.JPG"), "image");
    assert.equal(kindFromExt("/a/notes.txt"), "file");
    assert.equal(kindFromExt("/a/no-ext"), "file");
  });
});

describe("parseAttachmentMessage", () => {
  it("returns the whole text as display when there is no suffix", () => {
    assert.deepEqual(parseAttachmentMessage("just text"), { display: "just text", attachments: [] });
    assert.deepEqual(parseAttachmentMessage(""), { display: "", attachments: [] });
  });

  it("splits display from a bracket-labelled attachment list with explicit kinds", () => {
    const text = "look at these\n\nattachments:\n- [a.png] (image): /abs/a.png\n- [docs] (folder): /abs/docs";
    assert.deepEqual(parseAttachmentMessage(text), {
      display: "look at these",
      attachments: [
        { label: "[a.png]", kind: "image", path: "/abs/a.png" },
        { label: "[docs]", kind: "folder", path: "/abs/docs" },
      ],
    });
  });

  it("infers kind from extension when the (kind) annotation is absent", () => {
    const text = "hi\n\nattachments:\n- [a]: /abs/a.png\n- [b]: /abs/b.txt";
    assert.deepEqual(parseAttachmentMessage(text).attachments, [
      { label: "[a]", kind: "image", path: "/abs/a.png" },
      { label: "[b]", kind: "file", path: "/abs/b.txt" },
    ]);
  });

  it("tolerates legacy {image #1} and bare kind: forms", () => {
    const text = "x\n\nattachments:\n- {image #1}: /abs/a.png\n- folder: /abs/docs";
    assert.deepEqual(parseAttachmentMessage(text).attachments, [
      { label: "{image #1}", kind: "image", path: "/abs/a.png" },
      { kind: "folder", path: "/abs/docs" },
    ]);
  });

  it("round-trips buildAttachmentSuffix output (writer ↔ reader stay in sync)", () => {
    const labels = ["[a.png]", "[b.txt]"];
    const paths = new Map([["[a.png]", "/abs/a.png"], ["[b.txt]", "/abs/b.txt"]]);
    const kinds = new Map([["[a.png]", "image"], ["[b.txt]", "file"]]);
    const parsed = parseAttachmentMessage("hi" + buildAttachmentSuffix(labels, paths, kinds));
    assert.equal(parsed.display, "hi");
    assert.deepEqual(parsed.attachments, [
      { label: "[a.png]", kind: "image", path: "/abs/a.png" },
      { label: "[b.txt]", kind: "file", path: "/abs/b.txt" },
    ]);
  });
});

describe("ChatAttachmentSchema", () => {
  it("accepts a full attachment and one without a label", () => {
    assert.equal(ChatAttachmentSchema.safeParse(
      { label: "[a.png]", kind: "image", path: "/abs/a.png", messageId: 3, ts: 100 },
    ).success, true);
    assert.equal(ChatAttachmentSchema.safeParse(
      { kind: "folder", path: "/abs/docs", messageId: 4, ts: 200 },
    ).success, true);
  });

  it("rejects an out-of-enum kind (video was cut from scope)", () => {
    assert.equal(ChatAttachmentSchema.safeParse(
      { kind: "video", path: "/abs/x.mp4", messageId: 1, ts: 1 },
    ).success, false);
  });
});
