// Eos's measuring script for a page design (05 Q3). The shell's hidden probe
// view loads a candidate's page at one width and evaluates this; it answers
// what a person would find hard to read there: text too small or too faint,
// a page wider than the window, a part with nothing in it. It reads the
// layout only; it changes nothing and fetches nothing.
(function (root) {
  "use strict";

  function channels(colour) {
    var m = /rgba?\(([^)]+)\)/.exec(colour || "");
    if (!m) return null;
    var parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function luminance(c) {
    var lin = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }

  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // The background a text is read on: the first opaque one around it, else
  // the sheet's white.
  function backdrop(el, style) {
    for (var at = el; at && at.nodeType === 1; at = at.parentNode) {
      var c = channels(style(at).backgroundColor);
      if (c && c.a >= 1) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function ownText(el) {
    var text = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) text += n.nodeValue;
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function partOf(el) {
    for (var at = el; at && at.nodeType === 1; at = at.parentNode) {
      if (at.getAttribute && at.getAttribute("data-part")) return at.getAttribute("data-part");
    }
    return null;
  }

  function scrolls(el, style) {
    for (var at = el; at && at.nodeType === 1; at = at.parentNode) {
      var o = style(at).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  }

  function measure(doc, win) {
    var style = function (el) { return win.getComputedStyle(el); };
    var width = win.innerWidth;
    var findings = [];
    var seen = {};
    var add = function (check, part, detail) {
      var key = check + "|" + part + "|" + detail;
      if (seen[key]) return;
      seen[key] = true;
      findings.push({ check: check, part: part, detail: detail });
    };
    var all = doc.body ? doc.body.getElementsByTagName("*") : [];
    if (doc.documentElement.scrollWidth > width + 1) {
      add("narrow", null, "the page is " + doc.documentElement.scrollWidth + " px wide in a " + width + " px window");
    }
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var s = style(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      var rect = el.getBoundingClientRect();
      if (rect.right > width + 1 && !scrolls(el.parentNode, style)) {
        add("narrow", partOf(el), "a box reaches " + Math.round(rect.right) + " px in a " + width + " px window");
      }
      var text = ownText(el);
      if (!text) continue;
      var size = parseFloat(s.fontSize);
      var least = text.length > 80 ? 14 : 12;
      if (size < least) add("readable", partOf(el), "text at " + size + " px, at least " + least + " px");
      var fg = channels(s.color);
      if (fg) {
        var bold = parseInt(s.fontWeight, 10) >= 700;
        var large = size >= 24 || (bold && size >= 18.66);
        var ratio = contrast(fg, backdrop(el, style));
        var need = large ? 3 : 4.5;
        if (ratio < need) {
          add("readable", partOf(el), "contrast " + ratio.toFixed(2) + ":1, at least " + need + ":1");
        }
      }
    }
    var parts = doc.querySelectorAll("[data-part]");
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (style(p).display === "none") continue;
      var box = p.getBoundingClientRect();
      var images = p.getElementsByTagName("img");
      var loaded = false;
      for (var k = 0; k < images.length; k++) if (images[k].complete && images[k].naturalWidth > 0) loaded = true;
      var visible = (p.textContent || "").trim().length > 0 || loaded;
      if (box.height <= 0 || !visible) add("empty", p.getAttribute("data-part"), "shows nothing");
    }
    return { width: width, findings: findings };
  }

  root.__eosProbe = { measure: measure, contrast: contrast, channels: channels };
  if (root.document) return measure(root.document, root);
})(typeof window !== "undefined" ? window : globalThis);
