import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../state/ui.jsx";
import { AppFrame } from "./AppFrame.jsx";
import { ConfirmChip } from "./ConfirmChip.jsx";
import { APP_CSP } from "./srcdoc.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const app = JSON.parse(
  readFileSync(new URL("../../../../../contracts/src/__tests__/fixtures/genui/app.json", import.meta.url), "utf8"),
);

const render = (el) => renderToStaticMarkup(<UiProvider>{el}</UiProvider>);
const frame = (props = {}) =>
  render(<AppFrame viewId="v_abcdefghijkl" title={app.title} html={app.html} height={app.height} summary={app.summary} onSend={() => {}} {...props} />);
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("AppFrame chrome", () => {
  it("shows the pill, the title, the four tools, the footer note and Save as page", () => {
    const html = frame();
    expect(html).toContain("APP · SANDBOXED");
    expect(html).toContain("V60 Brew Timer");
    for (const label of ["View source", "Reload app", "Open in side panel", "Fullscreen"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain("Runs in an isolated sandbox · no network");
    expect(html).toContain("Save as page");
  });

  it("frames the app in a sandboxed srcdoc iframe — scripts and forms only", () => {
    const html = frame();
    const tag = html.match(/<iframe[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('sandbox="allow-scripts allow-forms"');
    expect(tag).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups/);
    expect(tag).toContain('referrerPolicy="no-referrer"');
    expect(tag).toMatch(/allow="[^"]*geolocation &#x27;none&#x27;/);
    // required CSP (embedded enforcement): the frame can't navigate itself to a page that hasn't opted in
    expect(decode(tag.match(/\scsp="([^"]*)"/)?.[1] ?? "")).toBe(APP_CSP);
    const srcdoc = decode(tag.match(/srcDoc="([^"]*)"/)?.[1] ?? "");
    expect(srcdoc.startsWith('<!doctype html>\n<html lang="tr">\n<head>\n<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(srcdoc).toContain(APP_CSP);
    expect(srcdoc).toContain("const stages = [");
  });

  it("uses the declared height inline, clamped", () => {
    expect(frame()).toContain("height:460px");
    expect(frame({ height: 5000 })).toContain("height:720px");
    expect(frame({ height: undefined })).toContain("height:360px");
  });

  it("while the app is still being written there is no frame yet", () => {
    const html = frame({ pending: true });
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Building the app…");
  });

  it("the side-panel copy fills its tab and drops the open-in-panel button", () => {
    const html = frame({ mode: "panel" });
    expect(html).toContain("is-panel");
    expect(html).not.toContain('aria-label="Open in side panel"');
    expect(html).not.toMatch(/gv-app-stage" style="height/);
  });

  it("without source there is nothing to run, show, reload or save", () => {
    const html = frame({ html: "" });
    expect(html).not.toContain("<iframe");
    expect(html).toContain(app.summary.slice(0, 20));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save as page/);
  });

  it("says when this app may send without asking", () => {
    store.set("eos:genui:appsAlwaysSend", JSON.stringify(["v_abcdefghijkl"]));
    const html = frame();
    expect(html).toContain("Sends without asking · Ask again");
    expect(html).not.toContain("sends nothing without your OK");
    store.clear();
    expect(frame()).toContain("sends nothing without your OK");
  });
});

describe("confirmation chip", () => {
  it("shows exactly what the app wants to send, with Send · Dismiss · Always for this app", () => {
    const html = renderToStaticMarkup(<ConfirmChip text="Rebuild it for 20 g / 320 g" onSend={() => {}} onDismiss={() => {}} onAlways={() => {}} />);
    expect(html).toContain("App wants to send:");
    expect(html).toContain("<q class=\"gv-app-ask-text\">Rebuild it for 20 g / 320 g</q>");
    expect(html).toMatch(/>Send</);
    expect(html).toMatch(/>Dismiss</);
    expect(html).toMatch(/>Always for this app</);
  });

  it("a link the app wants to open shows the URL with Open · Dismiss, in a polite live region", () => {
    const html = renderToStaticMarkup(<ConfirmChip kind="link" text="https://example.com/?q=1" onSend={() => {}} onDismiss={() => {}} onAlways={() => {}} />);
    expect(html).toContain("App wants to open:");
    expect(html).toContain("https://example.com/?q=1");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open</);
    expect(html).toContain('role="status" aria-live="polite"');
  });

  it("Send is not armed on first paint, so a click already on its way can't accept it", () => {
    const html = renderToStaticMarkup(<ConfirmChip text="x" onSend={() => {}} onDismiss={() => {}} onAlways={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send</);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Always for this app</);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Dismiss</);
    const armed = renderToStaticMarkup(<ConfirmChip text="x" armDelay={0} onSend={() => {}} onDismiss={() => {}} onAlways={() => {}} />);
    expect(armed).not.toMatch(/disabled=""[^>]*>Send</);
  });
});
