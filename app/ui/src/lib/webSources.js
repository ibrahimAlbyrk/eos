// Turns WebSearch / WebFetch results into what the web tool cards show
// (views/agents/messages/WebToolCards.jsx). A WebSearch result is plain text:
//
//   Web search results for query: "…"
//   Links: [{"title":"…","url":"…"},…]      ← one or more of these
//   <the search's prose summary, markdown>
//   REMINDER: You MUST include the sources …
//
// The preamble and the reminder are instructions for the model, not content.

const PREAMBLE = /^Web search results for query:/;
const LINKS = /^Links:\s*(\[.*)$/;
const REMINDER = /^REMINDER: You MUST include the sources/;

function parseLinks(json) {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((l) => typeof l?.url === "string")
      .map((l) => ({ title: typeof l.title === "string" ? l.title : "", url: l.url }));
  } catch {
    return [];
  }
}

export function parseWebSearch(text) {
  const links = [];
  const kept = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(LINKS);
    if (m) links.push(...parseLinks(m[1]));
    else if (!PREAMBLE.test(line) && !REMINDER.test(line)) kept.push(line);
  }
  return { links, summary: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

// "https://www.x.com/a?b" → { host: "x.com", rest: "/a?b", secure: true }; null when unparseable
export function splitUrl(url) {
  try {
    const u = new URL(url);
    const rest = u.pathname + u.search + u.hash;
    return { host: u.hostname.replace(/^www\./, ""), rest: rest === "/" ? "" : rest, secure: u.protocol === "https:" };
  } catch {
    return null;
  }
}

// Country-code domains register one level deeper: "unimelb.edu.au", "bbc.co.uk".
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

// "docs.cocos.com" → "cocos.com", so one site's pages share one chip.
export function siteOf(host) {
  const labels = host.split(".");
  const ccSld = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2));
  return labels.slice(ccSld ? -3 : -2).join(".");
}

// Links grouped by site in first-seen order, repeated URLs dropped.
export function groupBySite(links) {
  const sites = new Map();
  for (const link of links) {
    const parts = splitUrl(link.url);
    if (!parts) continue;
    const name = siteOf(parts.host);
    const site = sites.get(name) ?? { name, links: [] };
    if (!site.links.some((l) => l.url === link.url)) site.links.push(link);
    sites.set(name, site);
  }
  return [...sites.values()];
}

// A stable hue per site, so its letter tile keeps one color everywhere.
export function siteHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
