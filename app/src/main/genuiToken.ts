import type { Session } from "electron";

// Visual answers load images (<img>) and map tiles (MapLibre) from the daemon's
// media/map proxy, which wants the ui-token — and neither can add a header. So
// the main window's session adds it, for exactly those two prefixes of this
// Mac's daemon; nothing else gains a token it didn't send itself. (A controlled
// computer's view gets its own view token from hosts.ts.)
const PREFIXES = ["/api/genui/media/", "/api/genui/map/"];

// Only subresource loads need it. A frame navigated to the proxy (an app's
// sandboxed iframe, say) must never ride the token.
const NAVIGATIONS = new Set(["mainFrame", "subFrame"]);

export function genuiTokenPrefixes(daemonUrl: string): string[] {
  const base = daemonUrl.replace(/\/+$/, "");
  return PREFIXES.map((p) => base + p);
}

export function wantsGenuiToken(url: string, resourceType: string, prefixes: readonly string[]): boolean {
  return !NAVIGATIONS.has(resourceType) && prefixes.some((p) => url.startsWith(p));
}

export function installGenuiTokenHeader(ses: Session, daemonUrl: string, token: () => string | null): void {
  const prefixes = genuiTokenPrefixes(daemonUrl);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const t = token();
    const hit = !!t && wantsGenuiToken(details.url, details.resourceType, prefixes);
    callback({ requestHeaders: hit ? { ...details.requestHeaders, "x-eos-ui-token": t as string } : details.requestHeaders });
  });
}
