import { api } from "../../api/client.js";

// → { kind: "web", url } | { kind: "file", path } | null for any other scheme.
export function resolveTerminalLink(uri) {
  let u;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") return { kind: "web", url: u.href };
  if (u.protocol === "file:") return { kind: "file", path: decodeURIComponent(u.pathname) };
  return null;
}

// ⌘+click opens, like Ghostty / iTerm / VS Code — a plain click stays a click
// (Claude Code tracks the mouse, so it gets plain clicks for its own UI).
// Web links go to the system browser (the app's window-open handler), files to
// their default app via the daemon.
export function openTerminalLink(e, uri) {
  if (!e.metaKey) return;
  const link = resolveTerminalLink(uri);
  if (!link) return;
  if (link.kind === "web") window.open(link.url, "_blank", "noopener");
  else api.openFile(link.path).catch(() => {});
}

// xterm's own OSC 8 handling ignores file:// and opens web links via
// confirm() + window.open(), which the app shell blocks — so replace it.
export const oscLinkHandler = { allowNonHttpProtocols: true, activate: openTerminalLink };
