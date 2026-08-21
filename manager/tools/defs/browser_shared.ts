// Shared plumbing for the browser_* verb handlers. Every acting verb takes an
// optional tabId; omitted ⇒ the ACTIVE (foreground) tab — the page the human is
// viewing in the shared panel, resolved by the daemon (a tab is brought to the
// foreground when the panel subscribes to it). There is no first-tab fallback:
// acting on a tab the human is not looking at is worse than a clear failure, so
// an omitted tabId with no foreground errors out.

import type { ToolContext } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";

export async function resolveTabId(ctx: ToolContext, tabId?: string): Promise<string> {
  if (tabId) return tabId;
  try {
    const res = (await ctx.api("GET", ROUTES.browserActiveTab)) as { tabId?: string };
    if (res?.tabId) return res.tabId;
  } catch {
    // GET /browser/active-tab 409s when the panel is viewing no tab (or the
    // subsystem is off) — surface the actionable hint below, not a raw daemon
    // error string.
  }
  throw new Error(
    "no active tab — the browser panel is not viewing any tab; open one with browser_new_tab, focus a tab in the panel, or pass an explicit tabId",
  );
}
