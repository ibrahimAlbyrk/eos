// Baseline shown until the daemon's live catalog (GET /v1/models via
// /api/ui-config) arrives; applyCatalog() then swaps the entries in place so
// every consumer — including the settings registry's lazy options — sees the
// fresh list on the next render. ctxTokens (from the API's maxInputTokens) is
// the single source of truth for context-window size: the picker's "200k"/"1M"
// label and the usage meter's total both derive from it.
const BASELINE = [
  { id: "haiku-5.5",  aliases: ["haiku"],  label: "haiku-5.5",  name: "Haiku 5.5",  ctxTokens: 1_000_000, tag: "fastest" },
  { id: "sonnet-5.5", aliases: ["sonnet"], label: "sonnet-5.5", name: "Sonnet 5.5", ctxTokens: 1_000_000, tag: "balanced" },
  { id: "opus-5.5",   aliases: ["opus"],   label: "opus-5.5",   name: "Opus 5.5",   ctxTokens: 1_000_000, tag: "most capable" },
  { id: "fable-5.2",  aliases: ["fable"],  label: "fable-5.2",  name: "Fable 5.2",  ctxTokens: 1_000_000, tag: "most powerful" },
];

// Every model a picker lists: the Claude catalog, then the models of the other
// providers a chat can run on (each with its provider's `provider` label).
export const MODELS = [...BASELINE];
let claudeModels = BASELINE;
let providerModels = [];

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
  return family ? claudeModels.find((m) => m.id.startsWith(`${family.key}-`)) ?? null : null;
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
      apiId: latest.id,
      label: shortId,
      name: String(latest.displayName ?? "").replace(/^Claude\s+/, "") || shortId,
      ctxTokens: Number.isFinite(latest.maxInputTokens) && latest.maxInputTokens > 0 ? latest.maxInputTokens : null,
      efforts: Array.isArray(latest.effortLevels) ? latest.effortLevels : null,
      tag,
    });
  }
  return out;
}

let catalogVersion = 0;
const catalogListeners = new Set();

// The model string a picker sends to the agent: the catalog's exact id, so the
// agent runs the version the menu shows even when the bundled Claude Code is
// older and would resolve the family alias to an earlier version. The baseline
// (no catalog yet) has only the family alias.
export const modelCommitId = (m) => m.apiId ?? m.aliases?.[0] ?? m.id;

function publish() {
  MODELS.length = 0;
  MODELS.push(...claudeModels, ...providerModels);
  catalogVersion += 1;
  for (const fn of catalogListeners) fn();
}

export function applyCatalog(catalog) {
  const curated = curateCatalog(catalog);
  if (!curated.length) return;
  claudeModels = curated;
  publish();
}

// The models of the providers besides Claude (GET /api/providers); a provider
// with no sign-in or key offers none.
export function applyProviders(providers) {
  if (!Array.isArray(providers)) return;
  providerModels = providers.filter((p) => p?.ready).flatMap((p) => (p.models ?? []).map((m) => ({
    id: m.id,
    aliases: [],
    apiId: m.id,
    label: m.id,
    name: m.displayName || m.id,
    ctxTokens: Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : null,
    efforts: Array.isArray(m.effortLevels) ? m.effortLevels : null,
    provider: p.label,
  })));
  publish();
}

// The models a chat of this kind can run on: another provider's only in a
// focused chat.
export const modelsFor = (focused) => (focused ? MODELS : MODELS.filter((m) => !m.provider));

// For useSyncExternalStore: a view listing MODELS re-renders when a fresh
// catalog lands while it is open.
export function subscribeCatalog(fn) {
  catalogListeners.add(fn);
  return () => catalogListeners.delete(fn);
}

export const getCatalogVersion = () => catalogVersion;

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

export function isKnownModel(raw) {
  return resolveModel(raw) !== null;
}

// The provider label of a model that is not Claude's (null for Claude's).
export function modelProvider(raw) {
  return resolveModel(raw)?.provider ?? null;
}

export function modelCtx(raw) {
  return formatCtx(resolveModel(raw)?.ctxTokens) || null;
}

export function modelCtxTokens(raw) {
  return resolveModel(raw)?.ctxTokens ?? null;
}
