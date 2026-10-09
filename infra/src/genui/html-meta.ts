// Reads the few <head> hints the media resolver needs from a page: its
// og:image / twitter:image, and its icons. A tolerant scan over <meta>/<link>
// tags, not an HTML parser — pages are capped at 1 MB and only the head counts.

const TAG_RE = /<(meta|link)\b([^>]*)>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", "#x2F": "/", "#47": "/" };

function decode(s: string): string {
  return s.replace(/&(#?[a-zA-Z0-9]+);/g, (m, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m).trim();
}

interface Tag {
  name: "meta" | "link";
  attrs: Record<string, string>;
}

function headOf(html: string): string {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  return end > 0 ? html.slice(0, end) : html;
}

function tags(html: string): Tag[] {
  const out: Tag[] = [];
  for (const m of headOf(html).matchAll(TAG_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(ATTR_RE)) {
      attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    out.push({ name: m[1].toLowerCase() as Tag["name"], attrs });
  }
  return out;
}

function absolute(href: string, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// The page's preview image: og:image (secure_url first), twitter:image, then
// <link rel="image_src">. Relative URLs resolve against the page URL.
export function extractPreviewImage(html: string, pageUrl: string): string | null {
  const all = tags(html);
  const meta = (key: string): string | null => {
    for (const t of all) {
      if (t.name !== "meta") continue;
      const k = (t.attrs.property ?? t.attrs.name ?? t.attrs.itemprop ?? "").toLowerCase();
      if (k === key && t.attrs.content) return t.attrs.content;
    }
    return null;
  };
  const candidates = [
    meta("og:image:secure_url"),
    meta("og:image"),
    meta("og:image:url"),
    meta("twitter:image"),
    meta("twitter:image:src"),
    meta("image"),
    all.find((t) => t.name === "link" && (t.attrs.rel ?? "").toLowerCase() === "image_src")?.attrs.href ?? null,
  ];
  for (const c of candidates) {
    const url = c ? absolute(c, pageUrl) : null;
    if (url) return url;
  }
  return null;
}

function largestSide(sizes: string | undefined): number {
  if (!sizes) return 0;
  if (sizes.toLowerCase() === "any") return 512;
  let best = 0;
  for (const m of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) best = Math.max(best, Number(m[1]));
  return best;
}

// The page's icons, best first: apple-touch-icon (largest), then rel=icon
// (vector or largest), then /apple-touch-icon.png and /favicon.ico at the root.
export function extractIcons(html: string, pageUrl: string): string[] {
  const apple: Array<{ url: string; score: number }> = [];
  const icons: Array<{ url: string; score: number }> = [];
  for (const t of tags(html)) {
    if (t.name !== "link") continue;
    const rel = (t.attrs.rel ?? "").toLowerCase().split(/\s+/);
    const url = absolute(t.attrs.href ?? "", pageUrl);
    if (!url) continue;
    const side = largestSide(t.attrs.sizes);
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) {
      apple.push({ url, score: side || 180 });
    } else if (rel.includes("icon")) {
      const vector = (t.attrs.type ?? "").includes("svg") || /\.svg(\?|$)/i.test(url);
      icons.push({ url, score: vector ? 256 : side || 32 });
    }
  }
  apple.sort((a, b) => b.score - a.score);
  icons.sort((a, b) => b.score - a.score);
  let root: string;
  try {
    root = new URL("/", pageUrl).toString();
  } catch {
    root = pageUrl;
  }
  const ordered = [...apple, ...icons].map((c) => c.url);
  ordered.push(new URL("apple-touch-icon.png", root).toString(), new URL("favicon.ico", root).toString());
  return [...new Set(ordered)];
}

// "Example.com", "https://www.example.com/a" → "example.com"/"www.example.com";
// null when it isn't a public-looking domain name.
export function normalizeSite(site: string): string | null {
  const raw = site.trim();
  if (!raw || raw.length > 253) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host)) return null;
  return host;
}
