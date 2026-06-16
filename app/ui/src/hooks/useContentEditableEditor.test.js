import { describe, it, expect } from "vitest";
import { scrollDelta, linearize } from "./useContentEditableEditor.js";

// Plain-object stubs mimic just the DOM surface linearize touches (nodeType,
// data, tagName, childNodes) — no jsdom needed, same approach as scrollAnchor.
const txt = (data) => ({ nodeType: 3, data });
const elem = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
const br = () => elem("BR");
const editor = (...kids) => elem("DIV", ...kids); // contentEditable root is a DIV

// box = [100, 300], margin = 8 → visible band [108, 292]
describe("scrollDelta", () => {
  it("returns 0 when the range is within the margin band", () => {
    expect(scrollDelta(150, 170, 100, 300)).toBe(0);
  });

  it("scrolls up (negative) when the range is above the top margin", () => {
    expect(scrollDelta(50, 70, 100, 300)).toBe(-58); // 50 - (100 + 8)
  });

  it("scrolls down (positive) when the range is below the bottom margin", () => {
    expect(scrollDelta(320, 340, 100, 300)).toBe(48); // 340 - (300 - 8)
  });

  it("prioritizes the top edge when a tall range overflows both ends", () => {
    expect(scrollDelta(50, 360, 100, 300)).toBe(-58);
  });

  it("honors a custom margin", () => {
    expect(scrollDelta(95, 110, 100, 300, 0)).toBe(-5); // 95 - 100
  });
});

describe("linearize — model text", () => {
  it("flat text passes through verbatim", () => {
    expect(linearize(editor(txt("hello world"))).text).toBe("hello world");
  });

  it("counts <br> as a newline (what native paste/Enter produce)", () => {
    const dom = editor(txt("A"), br(), txt("B"), br(), txt("C"));
    expect(linearize(dom).text).toBe("A\nB\nC");
  });

  it("counts block-element boundaries as a newline, no leading newline", () => {
    const dom = editor(editor(txt("a")), editor(txt("b")));
    expect(linearize(dom).text).toBe("a\nb");
  });

  it("inline spans add no newline", () => {
    const dom = editor(txt("hello "), elem("SPAN", txt("/clear")));
    expect(linearize(dom).text).toBe("hello /clear");
  });

  it("keeps literal newlines already in a text node (canonical DOM)", () => {
    expect(linearize(editor(txt("A\nB\nC"))).text).toBe("A\nB\nC");
  });
});

describe("linearize — caret offset agrees with the text", () => {
  // The bug: pasting "A\nB\nC" leaves the DOM as A<br>B<br>C with the caret
  // after "C". The old getCursorOffset (Range.toString) returned 3, so the
  // caret was restored 2 short (= the two line breaks). It must be 5 = end.
  it("caret after the last char of a <br>-split paste lands at the end", () => {
    const last = txt("C");
    const dom = editor(txt("A"), br(), txt("B"), br(), last);
    const { text, offsets } = linearize(dom, [{ node: last, offset: 1 }]);
    expect(offsets[0]).toBe(5);
    expect(offsets[0]).toBe(text.length);
  });

  it("caret inside a text node maps char-for-char past earlier breaks", () => {
    const mid = txt("BB");
    const dom = editor(txt("A"), br(), mid, br(), txt("C"));
    // "A\nBB\nC" → after first B inside mid = index 3
    expect(linearize(dom, [{ node: mid, offset: 1 }]).offsets[0]).toBe(3);
  });

  it("caret given as (element, childIndex) is located between children", () => {
    const root = editor(txt("A"), br(), txt("B"));
    // point between text "A" (child 0) and the <br> (child 1)
    expect(linearize(root, [{ node: root, offset: 1 }]).offsets[0]).toBe(1);
  });

  it("a point on an unvisited node clamps to the text length", () => {
    const dom = editor(txt("abc"));
    expect(linearize(dom, [{ node: txt("orphan"), offset: 0 }]).offsets[0]).toBe(3);
  });

  it("locates multiple points in one walk (selection start + end)", () => {
    const a = txt("A");
    const c = txt("C");
    const dom = editor(a, br(), txt("B"), br(), c);
    const { offsets } = linearize(dom, [
      { node: a, offset: 0 },
      { node: c, offset: 1 },
    ]);
    expect(offsets).toEqual([0, 5]);
  });
});
