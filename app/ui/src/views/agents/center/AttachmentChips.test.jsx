import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentChips } from "./AttachmentChips.jsx";

const render = (attachments) => renderToStaticMarkup(<AttachmentChips attachments={attachments} />);

describe("AttachmentChips", () => {
  it("shows an image as a bare preview tile", () => {
    const html = render([{ label: "[shot.png]", kind: "image", path: "/tmp/shot.png", status: "ready" }]);
    expect(html).toContain("att-preview--image");
    expect(html).toContain("att-shot");
    expect(html).not.toContain("att-text");
  });

  it("spins an image tile while it uploads", () => {
    const html = render([{ label: "[image.png]", kind: "image", path: null, status: "uploading" }]);
    expect(html).toContain("att-preview--image");
    expect(html).toContain("att-spinner");
  });

  it("previews text and HTML files over a name strip", () => {
    const html = render([
      { label: "[plan.md]", kind: "file", path: "/p/docs/plan.md", status: "ready" },
      { label: "[index.html]", kind: "file", path: "/p/site/index.html", status: "ready" },
    ]);
    expect(html.match(/att-preview--doc/g)).toHaveLength(2);
    expect(html).toContain("att-page-text");
    expect(html).toContain("att-page-html");
    expect(html.match(/att-caption/g)).toHaveLength(2);
  });

  it("keeps folders, pdfs and uploading files as compact cards", () => {
    const html = render([
      { label: "[src]", kind: "folder", path: "/p/app/src", status: "ready" },
      { label: "[spec.pdf]", kind: "file", path: "/p/docs/spec.pdf", status: "ready" },
      { label: "[notes.md]", kind: "file", path: null, status: "uploading" },
    ]);
    expect(html).not.toContain("att-preview");
    expect(html).toContain("p/app");
    expect(html).toContain("Uploading…");
  });
});
