// Host side of the app bridge — the MCP Apps subset Eos speaks over
// postMessage (JSON-RPC 2.0). Pure: routeAppMessage() turns one window
// "message" event into one effect for AppFrame to carry out, so the rules (who
// may talk, what each method does, the rate limits, when the user must confirm)
// are unit-tested without a DOM.
//
//   ui/initialize                 → host context (theme, display mode, size, locale…)
//   ui/notifications/size-changed → the frame's height (clamped inline)
//   ui/open-link                  → the Eos browser panel, http(s) only, after a
//                                   confirmation chip unless "Always" was chosen
//   ui/message                    → a confirmation chip, unless "Always" was chosen
//   any other request             → JSON-RPC "method not found"
//
// Everything else — other sources, other origins, non-JSON-RPC data,
// responses, unknown notifications — is ignored.

import { MCP_THEME_VARIABLES } from "./theme.js";
import { APP_PROTOCOL_VERSION } from "./srcdoc.js";

export const INLINE_MIN_HEIGHT = 160;
export const INLINE_MAX_HEIGHT = 720;
export const DEFAULT_APP_HEIGHT = 360;
// One message to the agent (and one link) per two seconds, whatever the app does.
export const MESSAGE_INTERVAL_MS = 2000;
export const LINK_INTERVAL_MS = 2000;
export const MAX_MESSAGE_CHARS = 8000;
const MAX_METHOD_CHARS = 100;
const MAX_ID_CHARS = 200;

export const RPC_ERRORS = Object.freeze({
  invalidParams: -32602,
  methodNotFound: -32601,
  // MCP Apps' implementation-defined code for a denied/failed host action.
  denied: -32000,
});

export function clampInlineHeight(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return DEFAULT_APP_HEIGHT;
  return Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, Math.round(n)));
}

export const rpcResult = (id, result = {}) => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
export const rpcNotification = (method, params) => ({ jsonrpc: "2.0", method, params });

const validId = (id) =>
  (typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS) || (typeof id === "number" && Number.isFinite(id));

// A JSON-RPC request or notification, or null for anything else (responses
// included — the host sends the app no requests).
export function readRpc(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.jsonrpc !== "2.0") return null;
  const { method } = data;
  if (typeof method !== "string" || !method || method.length > MAX_METHOD_CHARS) return null;
  const params = data.params && typeof data.params === "object" ? data.params : {};
  if (!("id" in data) || data.id === undefined) return { method, params, id: null, isRequest: false };
  if (!validId(data.id)) return null;
  return { method, params, id: data.id, isRequest: true };
}

// The text of a ui/message: content as one block (the spec's example) or a
// list of blocks (the SDK's type); text blocks joined.
export function messageText(params) {
  if (!params || typeof params !== "object") return null;
  if (params.role !== undefined && params.role !== "user") return null;
  const blocks = Array.isArray(params.content) ? params.content : [params.content];
  const parts = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const text = parts.join("\n\n").trim();
  return text ? text : null;
}

// The URL to open, normalized, when it is an http(s) link — else null.
export function allowedLink(url) {
  if (typeof url !== "string" || url.length > 4096) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// hostContext for ui/initialize and host-context-changed. `fixed` = the frame
// has a set height the app should fill; otherwise it sizes itself up to the max.
export function buildHostContext({ displayMode = "inline", width = null, height = null, fixed = false, locale, timeZone } = {}) {
  const dims = {};
  if (fixed && Number.isFinite(height)) dims.height = Math.round(height);
  else dims.maxHeight = INLINE_MAX_HEIGHT;
  if (Number.isFinite(width) && width > 0) dims.width = Math.round(width);
  return {
    theme: "dark",
    styles: { variables: { ...MCP_THEME_VARIABLES } },
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: dims,
    locale: locale ?? defaultLocale(),
    timeZone: timeZone ?? defaultTimeZone(),
    userAgent: "eos",
    platform: "desktop",
    deviceCapabilities: { touch: false, hover: true },
  };
}

function defaultLocale() {
  try {
    return globalThis.navigator?.language || Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const IGNORE = Object.freeze({ type: "ignore" });

// One message event → one effect:
//   {type:"ignore"}
//   {type:"reply", message, initialized?}   post `message` back to the frame
//   {type:"resize", height}                  set the inline height (already clamped)
//   {type:"open-link", id, url}              open now (always-allowed), then reply rpcResult(id)
//   {type:"confirm-link", id, url}           show the chip; open + reply when the user answers
//   {type:"send", id, text}                  deliver now (always-allowed), then reply
//   {type:"confirm", id, text}               show the chip; reply when the user answers
// "stamp" on open-link/confirm-link/send/confirm names the rate-limit clock to restart.
//
// ctx: { frameWindow, now, lastMessageAt, lastLinkAt, awaitingUser,
//        alwaysSend, canSend, hostContext: () => object }
export function routeAppMessage(event, ctx) {
  const frameWindow = ctx?.frameWindow ?? null;
  // Only this frame's own window may speak, and a sandboxed srcdoc frame always
  // has the opaque origin — anything else is someone else's message.
  if (!event || !frameWindow || event.source !== frameWindow) return IGNORE;
  if (event.origin !== "null") return IGNORE;
  const rpc = readRpc(event.data);
  if (!rpc) return IGNORE;
  const { method, params, id, isRequest } = rpc;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  switch (method) {
    case "ui/initialize":
      if (!isRequest) return IGNORE;
      return {
        type: "reply",
        initialized: true,
        message: rpcResult(id, {
          protocolVersion: APP_PROTOCOL_VERSION,
          hostInfo: { name: "eos", version: "1" },
          hostCapabilities: { openLinks: {} },
          hostContext: typeof ctx.hostContext === "function" ? ctx.hostContext() : buildHostContext(),
        }),
      };

    case "ui/notifications/size-changed": {
      const h = Number(params.height);
      if (!Number.isFinite(h) || h <= 0) return isRequest ? { type: "reply", message: rpcError(id, RPC_ERRORS.invalidParams, "height must be a positive number") } : IGNORE;
      return { type: "resize", height: clampInlineHeight(h), reply: isRequest ? rpcResult(id) : null };
    }

    case "ui/open-link": {
      if (!isRequest) return IGNORE;
      const url = allowedLink(params.url);
      if (!url) return { type: "reply", message: rpcError(id, RPC_ERRORS.denied, "Only http and https links can be opened") };
      if (ctx.awaitingUser) return { type: "reply", message: rpcError(id, RPC_ERRORS.denied, "A request is already waiting for the user") };
      if (now - (ctx.lastLinkAt ?? -Infinity) < LINK_INTERVAL_MS) {
        return { type: "reply", message: rpcError(id, RPC_ERRORS.denied, "Too many links — wait a moment") };
      }
      // A URL can carry whatever the user typed into the app, so opening one is
      // sending: the same confirmation as ui/message.
      return { type: ctx.alwaysSend ? "open-link" : "confirm-link", id, url, stamp: "link" };
    }

    case "ui/message": {
      if (!isRequest) return IGNORE;
      if (!ctx.canSend) return { type: "reply", message: rpcError(id, RPC_ERRORS.denied, "Messages can't be sent from here") };
      const text = messageText(params);
      if (!text) return { type: "reply", message: rpcError(id, RPC_ERRORS.invalidParams, "Invalid message format") };
      if (text.length > MAX_MESSAGE_CHARS) {
        return { type: "reply", message: rpcError(id, RPC_ERRORS.invalidParams, `Message is ${text.length} characters, max ${MAX_MESSAGE_CHARS}`) };
      }
      // One question at a time: a second request could otherwise swap the text
      // under the user's cursor just before they press Send.
      if (ctx.awaitingUser) return { type: "reply", message: rpcError(id, RPC_ERRORS.denied, "A message is already waiting for the user") };
      if (now - (ctx.lastMessageAt ?? -Infinity) < MESSAGE_INTERVAL_MS) {
        return { type: "reply", message: rpcError(id, RPC_ERRORS.denied, "Too many messages — wait a moment") };
      }
      return { type: ctx.alwaysSend ? "send" : "confirm", id, text, stamp: "message" };
    }

    case "ping":
      return isRequest ? { type: "reply", message: rpcResult(id) } : IGNORE;

    default:
      return isRequest ? { type: "reply", message: rpcError(id, RPC_ERRORS.methodNotFound, `Method not found: ${method}`) } : IGNORE;
  }
}
