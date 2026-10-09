import type { Session, WebContents } from "electron";

// Geolocation is this Mac's location: only the main window's own dashboard
// (eos://app, top frame) may ask for it — never a controlled computer's view, a
// sandboxed app iframe, a raw-file frame or a web page. A sandboxed sub-frame
// with an opaque origin (an agent-authored app's srcdoc) gets no permission at
// all. Every other permission keeps Electron's behaviour without a handler:
// granted, except the deprecated synchronous clipboard read.

type Decide = (wc: WebContents | null, url: string, isMainFrame: boolean) => boolean;

function defaultFor(permission: string): boolean {
  return permission !== "deprecated-sync-clipboard-read";
}

export function isOpaqueSubFrame(url: string, origin: string | undefined, isMainFrame: boolean): boolean {
  if (isMainFrame) return false;
  return url.startsWith("about:") || url.startsWith("data:") || origin === "null";
}

function install(ses: Session, geolocation: Decide): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = details.requestingUrl ?? "";
    if (isOpaqueSubFrame(url, undefined, details.isMainFrame)) return callback(false);
    if (permission !== "geolocation") return callback(defaultFor(permission));
    callback(geolocation(wc, url, details.isMainFrame));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const url = details.requestingUrl ?? requestingOrigin ?? "";
    if (isOpaqueSubFrame(url, details.securityOrigin ?? requestingOrigin, details.isMainFrame)) return false;
    if (permission !== "geolocation") return defaultFor(permission);
    return geolocation(wc, url, details.isMainFrame);
  });
}

export function isDashboardUrl(url: string): boolean {
  return url === "eos://app" || url.startsWith("eos://app/");
}

// The main window's session: geolocation for its eos://app top frame only.
export function installMainWindowPermissions(ses: Session, mainContents: () => WebContents | null): void {
  install(ses, (wc, url, isMainFrame) => {
    const main = mainContents();
    return !!wc && !!main && wc.id === main.id && isMainFrame && isDashboardUrl(url);
  });
}

// Any other session (controlled computers' views, the claude.ai preview).
export function denyGeolocation(ses: Session): void {
  install(ses, () => false);
}
