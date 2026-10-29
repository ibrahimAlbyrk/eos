// claude.ai Artifact ids. One artifact has two URL forms that name the same
// uuid: claude.ai/code/artifact/<uuid> and claude.ai/artifact/<shortId>, where
// the short id is the uuid's 128 bits in base58 (Bitcoin alphabet), always 22
// characters. Dependency-free so the dashboard imports it too.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;
const MAX = (1n << 128n) - 1n;
const SHORT_ID = /^[1-9A-HJ-NP-Za-km-z]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT_URL = /^https:\/\/(?:preview\.)?claude\.(?:ai|com)\/(code\/)?artifact\/([A-Za-z0-9-]+)(?:[/?#]|$)/;

export function shortIdOf(slug: string): string | null {
  const id = slug.toLowerCase();
  if (!UUID.test(id)) return null;
  let n = BigInt(`0x${id.replaceAll("-", "")}`);
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  return out;
}

export function slugOfShortId(shortId: string): string | null {
  if (!SHORT_ID.test(shortId)) return null;
  let n = 0n;
  for (const c of shortId) n = n * BASE + BigInt(ALPHABET.indexOf(c));
  if (n > MAX) return null;
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The artifact's uuid from either URL form, or null for any other URL. */
export function artifactSlugFromUrl(url: string): string | null {
  const m = ARTIFACT_URL.exec(url.trim());
  if (!m) return null;
  const id = m[2];
  return m[1] ? (UUID.test(id.toLowerCase()) ? id.toLowerCase() : null) : slugOfShortId(id);
}

/** The page claude.ai serves for an artifact (its share link). */
export function artifactViewerUrl(slug: string): string {
  return `https://claude.ai/artifact/${shortIdOf(slug) ?? slug}`;
}
