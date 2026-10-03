// What the new-tab launcher's field does with its text. A leading sigil picks
// a mode — "#" finds pages, "@" finds files, "?" asks the agent — an address
// opens in the browser, and anything else becomes a web search.

const SEARCH_URL = "https://www.google.com/search?q=";
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_SCHEME = /^(about|file|data|view-source):/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/\S*)?$/i;
const HOST = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/\S*)?$/;

export const SIGILS = { "#": "pages", "@": "files", "?": "ask" };

export function resolveOmnibox(text) {
  const t = (text ?? "").trim();
  if (!t) return null;
  const mode = SIGILS[t[0]];
  if (mode) return { kind: mode, query: t.slice(1).trim() };
  if (SCHEME.test(t) || BARE_SCHEME.test(t)) return { kind: "url", url: t };
  if (!/\s/.test(t)) {
    if (LOCAL_HOST.test(t) || IPV4.test(t)) return { kind: "url", url: `http://${t}` };
    if (HOST.test(t)) return { kind: "url", url: `https://${t}` };
  }
  return { kind: "search", url: SEARCH_URL + encodeURIComponent(t), query: t };
}
