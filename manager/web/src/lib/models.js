export const MODELS = [
  { id: "haiku-4.5",  aliases: ["haiku"],  label: "haiku-4.5",  name: "Haiku 4.5",  ctx: "200k", tag: "fastest" },
  { id: "sonnet-4.5", aliases: ["sonnet"], label: "sonnet-4.5", name: "Sonnet 4.5", ctx: "200k", tag: "balanced" },
  { id: "opus-4.7",   aliases: ["opus"],   label: "opus-4.7",   name: "Opus 4.7",   ctx: "1M",   tag: "most capable" },
];

export function modelName(raw) {
  if (!raw) return null;
  for (const m of MODELS) {
    if (raw === m.id || m.aliases.includes(raw)) return m.name;
  }
  const match = raw.match(/claude-(\w+)-(\d[\d.]*)/);
  if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1) + " " + match[2];
  return raw;
}

export function modelCtx(raw) {
  if (!raw) return null;
  for (const m of MODELS) {
    if (raw === m.id || m.aliases.includes(raw)) return m.ctx;
  }
  return null;
}
