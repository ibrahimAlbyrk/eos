// Pure model behind the artifact card, peek, tab and list (views/artifacts/):
// one artifact's display data from a tool call merged with the catalog
// (contracts/src/artifacts.ts), relative times, account avatars, the list's
// filters and its grouping by Claude sign-in.
import { artifactViewerUrl } from "../../../../contracts/src/artifact-ids.ts";
import { artifactLabel } from "./artifactLink.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toMs = (when) => (typeof when === "number" ? when : when ? Date.parse(when) : NaN);
const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);

// "just now", "4 min ago", "2 h ago", "yesterday", "Mon", "Oct 21" ("Oct 21, 2025"
// in another year). Hours count only on the same day or within 6 h, so last
// night reads "yesterday" by morning.
export function artifactAgo(when, now = Date.now()) {
  const t = toMs(when);
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  const days = Math.round((dayStart(now) - dayStart(t)) / (24 * HOUR));
  if (days === 0 || diff < 6 * HOUR) return `${Math.floor(diff / HOUR)} h ago`;
  if (days === 1) return "yesterday";
  const d = new Date(t);
  if (days < 7) return WEEKDAYS[d.getDay()];
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

// The avatar letter for a sign-in: its label's first letter, else its email's.
export function accountInitial(account) {
  const source = `${account?.label ?? ""}${account?.email ?? ""}`;
  const ch = /\p{L}|\p{N}/u.exec(source)?.[0];
  return ch ? ch.toUpperCase() : "?";
}

// Avatar tints cycle through this many token colours (artifacts.css data-av).
export const AVATAR_TINTS = 5;

function accountView(accounts, loginId) {
  const i = loginId ? accounts.findIndex((a) => a.loginId === loginId) : -1;
  if (i === -1) return null;
  const a = accounts[i];
  return { loginId: a.loginId, label: a.label, email: a.email ?? null, initial: accountInitial(a), tint: i % AVATAR_TINTS };
}

// Everything the card, peek and tab show for one artifact. `seed` is what the
// opener knew (a tool call's url/title/ts, a tab's panel data); the catalog
// entry, when the catalog has the slug, wins over it.
export function artifactInfo(slug, seed = {}, catalog = null) {
  const entry = slug ? catalog?.artifacts?.find((a) => a.slug === slug) ?? null : null;
  return describeArtifact(slug, entry, seed, catalog?.accounts ?? []);
}

// artifactInfo for a catalog row already in hand (the list).
export function describeArtifact(slug, entry, seed, accounts) {
  const loginId = entry?.loginId ?? seed.loginId ?? null;
  const url = entry?.url ?? seed.url ?? (slug ? artifactViewerUrl(slug) : "");
  const updatedMs = toMs(entry?.updatedAt);
  return {
    slug,
    url,
    title: entry?.title || seed.title || artifactLabel(url) || "Artifact",
    kind: entry?.kind ?? null,
    versionLabel: entry?.versionLabel ?? null,
    version: entry?.version ?? null,
    updatedAt: Number.isFinite(updatedMs) ? updatedMs : seed.ts ?? null,
    tint: entry?.tint ?? null,
    favicon: entry?.favicon ?? null,
    rel: entry?.rel ?? null,
    loginId,
    account: accountView(accounts, loginId),
    known: Boolean(entry),
  };
}

// The bridge's Ref (window.eosArtifacts).
export function artifactRef(info) {
  return {
    slug: info.slug,
    loginId: info.loginId ?? null,
    url: info.url,
    ...(info.version ? { version: info.version } : {}),
    ...(info.title ? { title: info.title } : {}),
  };
}

// "Page · v3" — the kind (a plain page when the catalog doesn't say) and the
// label it was published with.
export function artifactKindLine(info) {
  return [info.kind ?? "Page", info.versionLabel].filter(Boolean).join(" · ");
}

// The card's second line: "Page · v3 · just now".
export function artifactMeta(info, now = Date.now()) {
  return [artifactKindLine(info), info.updatedAt != null ? artifactAgo(info.updatedAt, now) : null].filter(Boolean).join(" · ");
}

// A list row's second line; another person's artifact says so.
export function artifactRowLine(info) {
  return [artifactKindLine(info), info.rel === "shared" ? "shared with you" : null].filter(Boolean).join(" · ");
}

// The peek footer's "Personal · updated 2 h ago".
export function artifactAccountLine(info, now = Date.now()) {
  const when = info.updatedAt != null ? `updated ${artifactAgo(info.updatedAt, now)}` : null;
  return [info.account?.label, when].filter(Boolean).join(" · ");
}

// The peek footer's dot + word for the live view's state (bridge onState).
const VIEW_STATUS = {
  ready: { tone: "live", label: "Live" },
  signin: { tone: "warn", label: "Sign in to view" },
  error: { tone: "err", label: "Couldn't load" },
};
export function artifactViewStatus(state) {
  return VIEW_STATUS[state] ?? { tone: "loading", label: "Loading" };
}

// The tab's floating toolbar (bridge setToolbar).
export function artifactToolbar(info, now = Date.now()) {
  return {
    initial: info.account?.initial ?? "",
    account: info.account?.label ?? "",
    meta: [info.versionLabel, info.updatedAt != null ? artifactAgo(info.updatedAt, now) : null].filter(Boolean).join(" · "),
  };
}

export const REL_FILTERS = [
  { id: "all", label: "Mine & shared" },
  { id: "mine", label: "Mine" },
  { id: "shared", label: "Shared with me" },
];

// The list's filters: every search word must appear in the title, kind or
// label; `loginId` keeps one sign-in; `rel` mine / shared / all.
export function filterArtifacts(artifacts, { query = "", loginId = null, rel = "all" } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return artifacts.filter((a) => {
    if (loginId && a.loginId !== loginId) return false;
    if (rel !== "all" && a.rel !== rel) return false;
    if (!words.length) return true;
    const hay = `${a.title} ${a.kind ?? ""} ${a.versionLabel ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// One group per sign-in, in the catalog's account order, newest first inside.
// A sign-in shows when it has rows or a read error to report (unless the list
// is narrowed to another one); rows of a sign-in the catalog no longer lists
// close the list under "Other".
export function groupByAccount(artifacts, accounts, { loginId = null } = {}) {
  const byLogin = new Map();
  for (const a of artifacts) {
    if (!byLogin.has(a.loginId)) byLogin.set(a.loginId, []);
    byLogin.get(a.loginId).push(a);
  }
  const groups = [];
  accounts.forEach((account, i) => {
    const items = byLogin.get(account.loginId) ?? [];
    byLogin.delete(account.loginId);
    if (loginId && account.loginId !== loginId) return;
    if (items.length || account.error) groups.push({ account, tint: i % AVATAR_TINTS, items });
  });
  const rest = [...byLogin.values()].flat();
  if (rest.length) groups.push({ account: { loginId: null, label: "Other", count: rest.length }, tint: null, items: rest });
  return groups;
}

// The hover peek's box (views/artifacts/ArtifactPeek.jsx; its CSS fixes the
// size). It opens below the anchor and flips above when there's no room; an
// anchor in the side panel (`panelLeft` = the panel's left edge) gets it to the
// panel's left, beside the row, so it never covers the list.
export const PEEK_W = 420;
export const PEEK_H = 274;
const PEEK_GAP = 10;
const PEEK_EDGE = 8;

export function placeArtifactPeek(anchor, panelLeft, vw, vh) {
  const clampY = (y) => Math.max(PEEK_EDGE, Math.min(y, vh - PEEK_H - PEEK_EDGE));
  if (panelLeft != null && panelLeft - PEEK_GAP - PEEK_W >= PEEK_EDGE) {
    return { side: "left", left: panelLeft - PEEK_GAP - PEEK_W, top: clampY(anchor.top + anchor.height / 2 - PEEK_H / 2) };
  }
  const left = Math.max(PEEK_EDGE, Math.min(anchor.left, vw - PEEK_W - PEEK_EDGE));
  const roomBelow = vh - PEEK_EDGE - (anchor.bottom + PEEK_GAP);
  const roomAbove = anchor.top - PEEK_GAP - PEEK_EDGE;
  if (roomBelow >= PEEK_H || roomBelow >= roomAbove) return { side: "below", left, top: clampY(anchor.bottom + PEEK_GAP) };
  return { side: "above", left, top: clampY(anchor.top - PEEK_GAP - PEEK_H) };
}

// When the catalog was last read in full: the oldest of the sign-ins' reads.
export function catalogSyncedAt(accounts) {
  const times = accounts.map((a) => toMs(a.refreshedAt)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}
