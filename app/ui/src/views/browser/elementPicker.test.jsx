import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { pickerHoverRequest, boxToPercentRect, elementLabel, elementAttachment } from "./PickerLayer.jsx";
import { ElementPopover } from "./ElementPopover.jsx";
import { AttachmentChips } from "../code/center/AttachmentChips.jsx";
import { buildAttachmentSuffix, parseAttachmentMessage, elementSummary } from "../../lib/attachmentTokens.js";

// A representative BrowserElement (plan §3.1) as the daemon's /elements route
// returns it: viewport-CSS-px box, accname, durable locator.
const EL = {
  ref: "e7",
  tag: "img",
  role: "image",
  name: "Home",
  box: [40, 60, 24, 24],
  focusable: true,
  locator: 'role=img[name="Home"]',
};

describe("pickerHoverRequest", () => {
  it("maps a canvas CSS offset to a {hover:[x,y]} probe in viewport px", () => {
    // canvas shown at half the viewport's CSS size → coords double
    expect(pickerHoverRequest(160, 100, 640, 400, { width: 1280, height: 800 }))
      .toEqual({ hover: [320, 200] });
  });
  it("is identity when the surface matches the viewport", () => {
    expect(pickerHoverRequest(40, 60, 1280, 800, { width: 1280, height: 800 }))
      .toEqual({ hover: [40, 60] });
  });
});

describe("boxToPercentRect", () => {
  it("scales a viewport-px box back to a percentage highlight over the surface", () => {
    expect(boxToPercentRect([64, 40, 128, 80], { width: 1280, height: 800 }))
      .toEqual({ left: "5%", top: "5%", width: "10%", height: "10%" });
  });
});

describe("elementAttachment", () => {
  it("carries the compact BrowserElement — never outerHTML, never a screenshot", () => {
    const att = elementAttachment(EL);
    expect(att.type).toBe("element");
    expect(JSON.parse(att.path)).toEqual({
      ref: "e7", tag: "img", role: "image", name: "Home", locator: 'role=img[name="Home"]',
    });
    // no box / focusable / serialized HTML / image bytes leak into the payload
    expect(JSON.parse(att.path)).not.toHaveProperty("box");
    expect(att.path).not.toMatch(/outerHTML|<[a-z]/i);
    expect(att.path).not.toContain("data:image");
    expect(att.path.length).toBeLessThan(200); // ~40-80 tokens
  });
  it("labels the chip with the element identity (tag + name)", () => {
    expect(elementLabel(EL)).toBe("[img · Home]");
  });
});

describe("ElementPopover", () => {
  it("renders the tag, pixel dimensions and the accessibility block", () => {
    const html = renderToStaticMarkup(
      <ElementPopover element={EL} x={10} y={10} bounds={{ width: 1000, height: 800 }} />
    );
    expect(html).toContain(">img<");            // tag
    expect(html).toContain("24 × 24");           // box[2] × box[3]
    expect(html).toContain("Accessibility");
    expect(html).toContain("Name");
    expect(html).toContain("Home");              // accname
    expect(html).toContain("Role");
    expect(html).toContain("image");             // role
    expect(html).toContain("Keyboard-focusable");
    expect(html).toContain("Yes");               // focusable
  });
});

describe("AttachmentChips element chip", () => {
  it("renders the element identity as text, not a thumbnail", () => {
    const att = elementAttachment(EL);
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[{ label: att.label, kind: "element", path: att.path, status: "ready" }]} />
    );
    expect(html).toContain("att-element");
    expect(html).toContain("img");   // tag
    expect(html).toContain("Home");  // detail (accname)
    expect(html).not.toContain("att-thumb");
  });
});

describe("element attachment round-trips through attachmentTokens", () => {
  it("build → parse recovers the typed element entry with its compact payload", () => {
    const att = elementAttachment(EL);
    const suffix = buildAttachmentSuffix(
      [att.label],
      new Map([[att.label, att.path]]),
      new Map([[att.label, "element"]]),
    );
    expect(suffix).toContain("(element)");
    const parsed = parseAttachmentMessage("point at this" + suffix);
    expect(parsed.display).toBe("point at this");
    expect(parsed.attachments).toEqual([{ label: att.label, kind: "element", path: att.path }]);
    expect(JSON.parse(parsed.attachments[0].path)).toMatchObject({ ref: "e7", role: "image" });
  });
  it("leaves non-element messages to the shared parser", () => {
    const text = "x\n\nattachments:\n- [a.png] (image): /tmp/a.png";
    expect(parseAttachmentMessage(text).attachments).toEqual([
      { label: "[a.png]", kind: "image", path: "/tmp/a.png" },
    ]);
  });
  it("elementSummary pulls tag + detail out of the value", () => {
    expect(elementSummary(elementAttachment(EL).path)).toEqual({ tag: "img", detail: "Home" });
  });
});
