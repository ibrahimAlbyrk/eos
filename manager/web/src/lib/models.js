// Baseline shown until the daemon's live catalog (GET /v1/models via
// /api/ui-config) arrives; applyCatalog() then swaps the entries in place so
// every consumer — including the settings registry's lazy options — sees the
// fresh list on the next render.
const BASELINE = [
  { id: "haiku-4.5",  aliases: ["haiku"],  label: "haiku-4.5",  name: "Haiku 4.5",  ctx: "200k", tag: "fastest" },
  { id: "sonnet-4.5", aliases: ["sonnet"], label: "sonnet-4.5", name: "Sonnet 4.5", ctx: "200k", tag: "balanced" },
  { id: "opus-4.8",   aliases: ["opus"],   label: "opus-4.8",   name: "Opus 4.8",   ctx: "1M",   tag: "most capable" },
];

export const MODELS = [...BASELINE];

const FAMILIES = [
  { key: "haiku",  tag: "fastest" },
  { key: "sonnet", tag: "balanced" },
  { key: "opus",   tag: "most capable" },
];

function formatCtx(maxInputTokens) {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) return "";
  if (maxInputTokens >= 1_000_000) return `${maxInputTokens / 1_000_000}M`;
  return `${Math.round(maxInputTokens / 1000)}k`;
}

export function curateCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  const out = [];
  for (const { key, tag } of FAMILIES) {
    const candidates = catalog.filter((m) => typeof m?.id === "string" && m.id.startsWith(`claude-${key}-`));
    if (!candidates.length) continue;
    candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    const latest = candidates[0];
    const version = latest.id
      .slice(`claude-${key}-`.length)
      .replace(/-\d{8}$/, "")
      .replace(/-/g, ".");
    const shortId = `${key}-${version}`;
    out.push({
      id: shortId,
      aliases: [key, latest.id],
      label: shortId,
      name: String(latest.displayName ?? "").replace(/^Claude\s+/, "") || shortId,
      ctx: formatCtx(latest.maxInputTokens),
      tag,
    });
  }
  return out;
}

export function applyCatalog(catalog) {
  const curated = curateCatalog(catalog);
  if (!curated.length) return;
  MODELS.length = 0;
  MODELS.push(...curated);
}

export const EFFORTS = [
  { id: "low",       label: "Low" },
  { id: "medium",    label: "Medium" },
  { id: "high",      label: "High" },
  { id: "xhigh",    label: "Extra high" },
  { id: "max",       label: "Max" },
  { id: "ultracode", label: "Ultracode" },
  { id: "auto",      label: "Auto" },
];

export const EFFORT_LABELS = Object.fromEntries(EFFORTS.map((e) => [e.id, e.label]));

export function modelName(raw) {
  if (!raw) return null;
  for (const m of MODELS) {
    if (raw === m.id || m.aliases.includes(raw)) return m.name;
  }
  const match = raw.match(/claude-([a-z]+)-(\d+(?:[.-]\d+)*)/i);
  if (match) {
    const version = match[2].split(/[.-]/).filter((p) => p.length < 4).join(".");
    return match[1].charAt(0).toUpperCase() + match[1].slice(1) + " " + version;
  }
  return raw;
}

export function modelCtx(raw) {
  if (!raw) return null;
  for (const m of MODELS) {
    if (raw === m.id || m.aliases.includes(raw)) return m.ctx;
  }
  return null;
}
