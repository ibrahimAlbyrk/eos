export const MODELS = [
  { id: "haiku-4.5",  aliases: ["haiku"],  label: "haiku-4.5",  name: "Haiku 4.5",  ctx: "200k", tag: "fastest" },
  { id: "sonnet-4.5", aliases: ["sonnet"], label: "sonnet-4.5", name: "Sonnet 4.5", ctx: "200k", tag: "balanced" },
  { id: "opus-4.8",   aliases: ["opus"],   label: "opus-4.8",   name: "Opus 4.8",   ctx: "1M",   tag: "most capable" },
];

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
