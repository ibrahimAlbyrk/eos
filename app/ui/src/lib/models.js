// Baseline shown until the daemon's live catalog (GET /v1/models via
// /api/ui-config) arrives; applyCatalog() then swaps the entries in place so
// every consumer — including the settings registry's lazy options — sees the
// fresh list on the next render. ctxTokens (from the API's maxInputTokens) is
// the single source of truth for context-window size: the picker's "200k"/"1M"
// label and the usage meter's total both derive from it.
const BASELINE = [
  { id: "haiku-4.5",  aliases: ["haiku"],  label: "haiku-4.5",  name: "Haiku 4.5",  ctxTokens: 200_000,   tag: "fastest" },
  { id: "sonnet-4.5", aliases: ["sonnet"], label: "sonnet-4.5", name: "Sonnet 4.5", ctxTokens: 1_000_000, tag: "balanced" },
  { id: "opus-4.8",   aliases: ["opus"],   label: "opus-4.8",   name: "Opus 4.8",   ctxTokens: 1_000_000, tag: "most capable" },
  { id: "fable-5",    aliases: ["fable"],  label: "fable-5",    name: "Fable 5",    ctxTokens: 1_000_000, tag: "most powerful" },
];

export const MODELS = [...BASELINE];

const FAMILIES = [
  { key: "haiku",  tag: "fastest" },
  { key: "sonnet", tag: "balanced" },
  { key: "opus",   tag: "most capable" },
  { key: "fable",  tag: "most powerful" },
];

function formatCtx(ctxTokens) {
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) return "";
  if (ctxTokens >= 1_000_000) return `${ctxTokens / 1_000_000}M`;
  return `${Math.round(ctxTokens / 1000)}k`;
}

function resolveModel(raw) {
  if (!raw) return null;
  for (const m of MODELS) {
    if (raw === m.id || m.aliases.includes(raw)) return m;
  }
  const lower = String(raw).toLowerCase();
  const family = FAMILIES.find(({ key }) => lower.includes(key));
  return family ? MODELS.find((m) => m.id.startsWith(`${family.key}-`)) ?? null : null;
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
      ctxTokens: Number.isFinite(latest.maxInputTokens) && latest.maxInputTokens > 0 ? latest.maxInputTokens : null,
      efforts: Array.isArray(latest.effortLevels) ? latest.effortLevels : null,
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
  { id: "xhigh",    label: "Extra" },
  { id: "max",       label: "Max" },
  { id: "ultracode", label: "Ultracode" },
];

export const EFFORT_LABELS = Object.fromEntries(EFFORTS.map((e) => [e.id, e.label]));

const EFFORT_API_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Picker choices for a model: API levels gated by the catalog capability
// (null = unknown → show all; [] = no effort support → hide the section).
// ultracode is a Claude-Code session feature, not an API level, so it
// survives whenever the model supports effort at all.
export function effortChoicesFor(raw) {
  const efforts = resolveModel(raw)?.efforts ?? null;
  if (!efforts) return EFFORTS;
  if (efforts.length === 0) return [];
  return EFFORTS.filter((e) => !EFFORT_API_LEVELS.includes(e.id) || efforts.includes(e.id));
}

export function modelName(raw) {
  if (!raw) return null;
  const m = MODELS.find((e) => raw === e.id || e.aliases.includes(raw));
  if (m) return m.name;
  const match = raw.match(/claude-([a-z]+)-(\d+(?:[.-]\d+)*)/i);
  if (match) {
    const version = match[2].split(/[.-]/).filter((p) => p.length < 4).join(".");
    return match[1].charAt(0).toUpperCase() + match[1].slice(1) + " " + version;
  }
  return raw;
}

export function modelCtx(raw) {
  return formatCtx(resolveModel(raw)?.ctxTokens) || null;
}

export function modelCtxTokens(raw) {
  return resolveModel(raw)?.ctxTokens ?? null;
}
