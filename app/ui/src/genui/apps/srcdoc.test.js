import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_ALLOW, APP_CSP, APP_SANDBOX, buildSrcdoc, splitDocument } from "./srcdoc.js";
import { MCP_THEME_VARIABLES } from "./theme.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../contracts/src/__tests__/fixtures/genui/app.json", import.meta.url), "utf8"),
);

// A live http-equiv attribute (not the defused data-eos-dropped-http-equiv).
const CSP_META_RE = /<meta[^>]*?[\s/"']http-equiv\s*=\s*["']?Content-Security-Policy/gi;

describe("app sandbox attributes", () => {
  it("runs scripts and forms in an opaque origin, nothing more", () => {
    const flags = APP_SANDBOX.split(/\s+/);
    expect(flags.sort()).toEqual(["allow-forms", "allow-scripts"]);
    for (const banned of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-top-navigation-by-user-activation", "allow-modals"]) {
      expect(flags).not.toContain(banned);
    }
  });

  it("denies powerful features through the permissions policy", () => {
    for (const f of ["camera", "microphone", "geolocation", "clipboard-read", "fullscreen"]) {
      expect(APP_ALLOW).toContain(`${f} 'none'`);
    }
  });

  it("the CSP blocks the network and keeps inline code", () => {
    const d = Object.fromEntries(APP_CSP.split(";").map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
    expect(d["default-src"]).toBe("'none'");
    expect(d["connect-src"]).toBe("'none'");
    expect(d["script-src"]).toBe("'unsafe-inline'");
    expect(d["style-src"]).toBe("'unsafe-inline'");
    expect(d["img-src"]).toBe("data: blob:");
    expect(d["font-src"]).toBe("data:");
    expect(d["form-action"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'none'");
    expect(APP_CSP).not.toMatch(/unsafe-eval|https?:|\*/);
  });
});

describe("buildSrcdoc", () => {
  it("opens with the doctype and our CSP as the first thing in <head>", () => {
    const doc = buildSrcdoc("<p>hi</p>");
    expect(doc.startsWith("<!doctype html>\n<html>\n<head>\n<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc).toContain(`content="${APP_CSP}"`);
  });

  it("publishes the theme as the MCP Apps variables and Eos aliases, before the app's CSS", () => {
    const doc = buildSrcdoc("<style>body{background:red}</style><p>x</p>");
    for (const key of ["--color-background-primary", "--color-text-primary", "--color-text-secondary", "--color-border-primary", "--font-sans", "--font-mono", "--border-radius-sm", "--border-radius-md", "--border-radius-lg"]) {
      expect(doc).toContain(`${key}:${MCP_THEME_VARIABLES[key]}`);
    }
    expect(doc).toContain("--eos-accent:#6ea4e8");
    expect(doc).toContain("color-scheme:dark");
    expect(doc.indexOf("data-eos-theme")).toBeLessThan(doc.indexOf("background:red"));
  });

  it("includes the bridge (window.eos over the MCP Apps methods) before the app's code", () => {
    const doc = buildSrcdoc("<script>window.app = 1</script>");
    const bridgeAt = doc.indexOf("data-eos-bridge");
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeLessThan(doc.indexOf("window.app = 1"));
    for (const m of ["ui/initialize", "ui/message", "ui/open-link", "ui/notifications/size-changed", "ui/notifications/initialized", "window.eos"]) {
      expect(doc).toContain(m);
    }
    // the bridge itself never closes the script element early
    const bridge = doc.slice(bridgeAt, doc.indexOf("</script>", bridgeAt));
    expect(bridge).not.toMatch(/<\/script/i);
  });

  it("auto-sizes only when the app declared no height", () => {
    expect(buildSrcdoc("<p>x</p>", { autoResize: true })).toContain("manual = false");
    expect(buildSrcdoc("<p>x</p>", { autoResize: false })).toContain("manual = true");
  });

  it("keeps the agent's app: head CSS in head, body content, <html>/<body> attributes", () => {
    const doc = buildSrcdoc(fixture.html, { autoResize: fixture.height == null });
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc).toContain('<html lang="tr">');
    expect(doc).toContain(".wrap { display: grid;");
    expect(doc).toContain('id="toggle"');
    expect(doc).toContain("const stages = [");
    const headEnd = doc.indexOf("</head>");
    expect(doc.indexOf(".wrap { display: grid;")).toBeLessThan(headEnd);
    expect(doc.indexOf('id="toggle"')).toBeGreaterThan(headEnd);
    expect(doc.match(/<html[\s>]/gi)).toHaveLength(1);
    expect(doc.match(/<body[\s>]/gi)).toHaveLength(1);

    const withBodyAttrs = buildSrcdoc('<html><body class="x" onload="go()"><main>m</main></body></html>');
    expect(withBodyAttrs).toContain('<body class="x" onload="go()">');
    expect(withBodyAttrs).toContain("<main>m</main>");
  });

  it("a document that brings its own permissive CSP still has ours first and only ours live", () => {
    const evil = [
      "<!doctype html><html><head>",
      '<meta http-equiv="Content-Security-Policy" content="default-src *; connect-src *">',
      "<META HTTP-EQUIV='refresh' CONTENT='0;url=https://example.com/'>",
      '<meta/http-equiv="refresh" content="0;url=https://example.com/">',
      "</head><body>",
      '<meta http-equiv="Content-Security-Policy" content="script-src *">',
      "<p>hi</p></body></html>",
    ].join("\n");
    const doc = buildSrcdoc(evil);
    const metas = [...doc.matchAll(CSP_META_RE)];
    expect(metas).toHaveLength(1);
    expect(metas[0].index).toBe(doc.indexOf("<head>") + "<head>\n".length);
    expect(doc).not.toMatch(/\shttp-equiv\s*=\s*["']?refresh/i);
    expect(doc).not.toMatch(/\/http-equiv=/i);
    expect(doc).toContain("data-eos-dropped-http-equiv");
    expect(doc).toContain("<p>hi</p>");
  });

  it("treats a fragment as body content", () => {
    const parts = splitDocument("  <div id=a>1</div>\n<script>x()</script>");
    expect(parts).toEqual({ htmlAttrs: "", head: "", bodyAttrs: "", body: "<div id=a>1</div>\n<script>x()</script>" });
    expect(splitDocument("﻿<!-- note --><!DOCTYPE html><p>x</p>").body).toBe("<p>x</p>");
  });

  it("reads quoted attributes that contain '>'", () => {
    const parts = splitDocument('<html data-x="a>b" lang=en><head><title>t</title></head><body data-y=\'c>d\'>z</body></html>');
    expect(parts.htmlAttrs).toBe(' data-x="a>b" lang=en');
    expect(parts.head).toBe("<title>t</title>");
    expect(parts.bodyAttrs).toBe(" data-y='c>d'");
    expect(parts.body).toBe("z");
  });

  it("does not mistake <header> for <head>", () => {
    const parts = splitDocument("<header>top</header><p>x</p>");
    expect(parts.head).toBe("");
    expect(parts.body).toBe("<header>top</header><p>x</p>");
  });

  it("survives empty and non-string input", () => {
    expect(buildSrcdoc("")).toContain("<body>\n\n</body>");
    expect(buildSrcdoc(null)).toContain("Content-Security-Policy");
  });
});
