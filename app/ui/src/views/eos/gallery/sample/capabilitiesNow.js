import samples from "./capabilities.json";

// The capabilities' calls and versions moved so the newest call was two
// hours before the gallery opened: they read "2h ago", never "1y ago".
const shift = (value, by) => {
  if (Array.isArray(value)) return value.map((v) => shift(v, by));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (k === "at" || k.endsWith("At")) && typeof v === "number" ? v + by : shift(v, by)]));
};
const newest = Math.max(...samples.flatMap((c) => (c.recentCalls ?? []).map((call) => call.at)));

export const capabilities = shift(samples, Date.now() - 2 * 60 * 60 * 1000 - newest);
