import { describe, it, expect, beforeEach } from "vitest";
import {
  INLINE_MAX_HEIGHT, INLINE_MIN_HEIGHT, LINK_INTERVAL_MS, MAX_MESSAGE_CHARS, MESSAGE_INTERVAL_MS, RPC_ERRORS,
  allowedLink, buildHostContext, clampInlineHeight, messageText, readRpc, routeAppMessage,
} from "./bridge.js";
import { isAlwaysSend, setAlwaysSend } from "./trust.js";
import { appPageBody, fenceFor } from "./pageExport.js";

const frame = { name: "the app's window" };
const other = { name: "someone else" };

const ev = (data, { source = frame, origin = "null" } = {}) => ({ data, source, origin });
const req = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const note = (method, params) => ({ jsonrpc: "2.0", method, params });
const say = (text, id = 7) => req("ui/message", { role: "user", content: [{ type: "text", text }] }, id);

const ctx = (over = {}) => ({
  frameWindow: frame,
  now: 100_000,
  lastMessageAt: -Infinity,
  lastLinkAt: -Infinity,
  awaitingUser: false,
  alwaysSend: false,
  canSend: true,
  hostContext: () => buildHostContext({ displayMode: "inline", width: 760, height: 460, fixed: true, locale: "tr-TR", timeZone: "Europe/Istanbul" }),
  ...over,
});

describe("who may talk", () => {
  it("ignores messages from any window but the frame's own", () => {
    expect(routeAppMessage(ev(say("hi"), { source: other }), ctx())).toEqual({ type: "ignore" });
    expect(routeAppMessage(ev(say("hi"), { source: null }), ctx())).toEqual({ type: "ignore" });
    expect(routeAppMessage(ev(say("hi")), ctx({ frameWindow: null }))).toEqual({ type: "ignore" });
  });

  it("ignores a non-opaque origin even from the frame's window", () => {
    expect(routeAppMessage(ev(say("hi"), { origin: "eos://app" }), ctx())).toEqual({ type: "ignore" });
    expect(routeAppMessage(ev(say("hi"), { origin: "http://127.0.0.1:7401" }), ctx())).toEqual({ type: "ignore" });
  });

  it("ignores anything that is not a JSON-RPC 2.0 request or notification", () => {
    for (const data of [null, "ui/message", 42, [], { method: "ui/message" }, { jsonrpc: "1.0", id: 1, method: "ui/message" },
      { jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: null, method: "ui/message" }, { jsonrpc: "2.0", id: {}, method: "x" },
      { jsonrpc: "2.0", id: 1, method: "x".repeat(101) }]) {
      expect(routeAppMessage(ev(data), ctx())).toEqual({ type: "ignore" });
    }
  });

  it("readRpc tells requests from notifications", () => {
    expect(readRpc(req("ui/initialize", {}, "a"))).toEqual({ method: "ui/initialize", params: {}, id: "a", isRequest: true });
    expect(readRpc(note("ui/notifications/initialized"))).toEqual({ method: "ui/notifications/initialized", params: {}, id: null, isRequest: false });
  });
});

describe("method routing", () => {
  it("ui/initialize answers with the host context", () => {
    const out = routeAppMessage(ev(req("ui/initialize", { protocolVersion: "2026-01-26" }, 3)), ctx());
    expect(out.type).toBe("reply");
    expect(out.initialized).toBe(true);
    expect(out.message.id).toBe(3);
    const { hostContext, hostCapabilities, protocolVersion } = out.message.result;
    expect(protocolVersion).toBe("2026-01-26");
    expect(hostCapabilities).toEqual({ openLinks: {} });
    expect(hostContext).toMatchObject({
      theme: "dark",
      platform: "desktop",
      displayMode: "inline",
      containerDimensions: { height: 460, width: 760 },
      locale: "tr-TR",
      timeZone: "Europe/Istanbul",
    });
    expect(hostContext.styles.variables["--color-background-primary"]).toBe("#171717");
  });

  it("a self-sizing app gets a max height instead of a fixed one", () => {
    expect(buildHostContext({ fixed: false, width: 700, locale: "en", timeZone: "UTC" }).containerDimensions).toEqual({ maxHeight: INLINE_MAX_HEIGHT, width: 700 });
  });

  it("size-changed sets the height, clamped to the inline range", () => {
    expect(routeAppMessage(ev(note("ui/notifications/size-changed", { width: 700, height: 412.4 })), ctx())).toMatchObject({ type: "resize", height: 412 });
    expect(routeAppMessage(ev(note("ui/notifications/size-changed", { height: 20 })), ctx())).toMatchObject({ type: "resize", height: INLINE_MIN_HEIGHT });
    expect(routeAppMessage(ev(note("ui/notifications/size-changed", { height: 99999 })), ctx())).toMatchObject({ type: "resize", height: INLINE_MAX_HEIGHT });
    expect(routeAppMessage(ev(note("ui/notifications/size-changed", { height: "tall" })), ctx())).toEqual({ type: "ignore" });
    expect(clampInlineHeight(Number.NaN)).toBeGreaterThanOrEqual(INLINE_MIN_HEIGHT);
  });

  it("open-link asks the user first (a URL can carry what was typed), then opens http(s) only", () => {
    expect(routeAppMessage(ev(req("ui/open-link", { url: "https://example.com/a b" }, 4)), ctx())).toEqual({
      type: "confirm-link", id: 4, url: "https://example.com/a%20b", stamp: "link",
    });
    expect(routeAppMessage(ev(req("ui/open-link", { url: "https://example.com/" }, 4)), ctx({ alwaysSend: true }))).toEqual({
      type: "open-link", id: 4, url: "https://example.com/", stamp: "link",
    });
    const waiting = routeAppMessage(ev(req("ui/open-link", { url: "https://example.com/" }, 4)), ctx({ awaitingUser: true }));
    expect(waiting.message.error.message).toMatch(/already waiting/);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "eos://app/", "not a url", 5]) {
      const out = routeAppMessage(ev(req("ui/open-link", { url }, 5)), ctx());
      expect(out.type).toBe("reply");
      expect(out.message.error.code).toBe(RPC_ERRORS.denied);
    }
    expect(allowedLink("HTTP://Example.com")).toBe("http://example.com/");
  });

  it("open-link is rate limited", () => {
    const out = routeAppMessage(ev(req("ui/open-link", { url: "https://example.com" })), ctx({ lastLinkAt: 100_000 - LINK_INTERVAL_MS + 1 }));
    expect(out.type).toBe("reply");
    expect(out.message.error.message).toMatch(/wait/);
  });

  it("unknown requests get method-not-found; unknown notifications are ignored", () => {
    const out = routeAppMessage(ev(req("tools/call", { name: "x" }, 9)), ctx());
    expect(out).toEqual({ type: "reply", message: { jsonrpc: "2.0", id: 9, error: { code: RPC_ERRORS.methodNotFound, message: "Method not found: tools/call" } } });
    expect(routeAppMessage(ev(note("notifications/message", { level: "info" })), ctx())).toEqual({ type: "ignore" });
    expect(routeAppMessage(ev(note("ui/notifications/initialized", {})), ctx())).toEqual({ type: "ignore" });
  });

  it("a ui/message sent as a notification is ignored (it needs an answer)", () => {
    expect(routeAppMessage(ev(note("ui/message", { role: "user", content: [{ type: "text", text: "x" }] })), ctx())).toEqual({ type: "ignore" });
  });
});

describe("ui/message needs the user", () => {
  it("asks for confirmation by default", () => {
    expect(routeAppMessage(ev(say("Start the 20 g recipe")), ctx())).toEqual({ type: "confirm", id: 7, text: "Start the 20 g recipe", stamp: "message" });
  });

  it("sends straight away once the user chose Always for this app", () => {
    expect(routeAppMessage(ev(say("again")), ctx({ alwaysSend: true }))).toEqual({ type: "send", id: 7, text: "again", stamp: "message" });
  });

  it("accepts the spec's single content block and joins text blocks", () => {
    expect(messageText({ role: "user", content: { type: "text", text: "one" } })).toBe("one");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }] })).toBe("a\n\nb");
    expect(messageText({ role: "assistant", content: [{ type: "text", text: "x" }] })).toBeNull();
  });

  it("rejects empty, malformed and oversized messages", () => {
    for (const params of [{ content: [] }, { content: [{ type: "text", text: "   " }] }, { content: "plain" }, {}]) {
      const out = routeAppMessage(ev(req("ui/message", params)), ctx());
      expect(out.message.error.code).toBe(RPC_ERRORS.invalidParams);
    }
    const big = routeAppMessage(ev(say("x".repeat(MAX_MESSAGE_CHARS + 1))), ctx());
    expect(big.message.error.message).toMatch(/max/);
  });

  it("allows one message per two seconds", () => {
    const soon = routeAppMessage(ev(say("hi")), ctx({ lastMessageAt: 100_000 - MESSAGE_INTERVAL_MS + 1 }));
    expect(soon.type).toBe("reply");
    expect(soon.message.error.code).toBe(RPC_ERRORS.denied);
    expect(routeAppMessage(ev(say("hi")), ctx({ lastMessageAt: 100_000 - MESSAGE_INTERVAL_MS })).type).toBe("confirm");
    // "always" does not lift the limit
    expect(routeAppMessage(ev(say("hi")), ctx({ alwaysSend: true, lastMessageAt: 99_000 })).type).toBe("reply");
  });

  it("refuses a second message while one waits for the user", () => {
    const out = routeAppMessage(ev(say("swap the text")), ctx({ awaitingUser: true }));
    expect(out.type).toBe("reply");
    expect(out.message.error.message).toMatch(/already waiting/);
  });

  it("refuses when the host can't send", () => {
    expect(routeAppMessage(ev(say("hi")), ctx({ canSend: false })).message.error.code).toBe(RPC_ERRORS.denied);
  });
});

describe("Always for this app", () => {
  const store = new Map();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  });

  it("is remembered per view id", () => {
    expect(isAlwaysSend("v_abcdefghijkl")).toBe(false);
    setAlwaysSend("v_abcdefghijkl", true);
    expect(isAlwaysSend("v_abcdefghijkl")).toBe(true);
    expect(isAlwaysSend("v_otherotherot")).toBe(false);
    setAlwaysSend("v_abcdefghijkl", false);
    expect(isAlwaysSend("v_abcdefghijkl")).toBe(false);
  });

  it("falls back to asking when storage throws or holds junk", () => {
    store.set("eos:genui:appsAlwaysSend", "{not json");
    expect(isAlwaysSend("v_abcdefghijkl")).toBe(false);
    globalThis.localStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(() => setAlwaysSend("v_abcdefghijkl", true)).not.toThrow();
    expect(isAlwaysSend("v_abcdefghijkl")).toBe(false);
  });
});

describe("Save as page", () => {
  it("writes the summary and the source in an html fence the source can't close", () => {
    expect(appPageBody({ summary: "A brew timer.", html: "<p>x</p>\n" })).toBe("A brew timer.\n\n```html\n<p>x</p>\n```\n");
    const tricky = "<pre>```js\nx\n```</pre>";
    expect(fenceFor(tricky)).toBe("````");
    expect(appPageBody({ summary: "", html: tricky })).toBe("````html\n<pre>```js\nx\n```</pre>\n````\n");
  });
});
