// Readers for markup attribute values, shared by the validator and the kit so a
// list, a column spec or a chip set means the same thing on both sides.
// Dependency-free (the UI imports it directly).
//
// Attribute values arrive as the parser left them: a string (quoted), a JSON value
// ({…}) or `true` (a bare flag). Lists accept either a JSON array or a string:
//   ids    (action ids, entity ids, field keys): split on commas and/or spaces
//   labels (options, tab labels, chips, cols):   split on "|" when present, else ","

export function splitIds(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(scalarText).filter(Boolean);
  if (typeof v === "number") return [String(v)];
  if (typeof v !== "string") return [];
  return v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export function splitLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (isObj(x) ? scalarText(x.label ?? x.title ?? x.name) : scalarText(x))).filter(Boolean);
  if (typeof v === "number") return [String(v)];
  if (typeof v !== "string") return [];
  const sep = v.includes("|") ? "|" : ",";
  return v.split(sep).map((x) => x.trim()).filter(Boolean);
}

export interface ColSpec {
  key: string;
  // "" = no header text.
  label: string;
}

// cols="name rating price" · cols="name:Venue, rating:Score" · cols={[{"key":"name","label":"Venue"}]}
export function parseCols(v: unknown): ColSpec[] {
  if (Array.isArray(v)) {
    return v
      .map((x): ColSpec | null => {
        if (isObj(x)) {
          const key = scalarText(x.key ?? x.field);
          return key ? { key, label: x.label === undefined ? key : scalarText(x.label) } : null;
        }
        return colEntry(scalarText(x));
      })
      .filter((c): c is ColSpec => c !== null);
  }
  if (typeof v !== "string") return [];
  const parts = v.includes("|") || v.includes(",") ? splitLabels(v) : v.split(/\s+/).filter(Boolean);
  return parts.map(colEntry).filter((c): c is ColSpec => c !== null);
}

function colEntry(raw: string): ColSpec | null {
  const s = raw.trim();
  if (!s) return null;
  const at = s.indexOf(":");
  if (at < 0) return { key: s, label: s };
  const key = s.slice(0, at).trim();
  return key ? { key, label: s.slice(at + 1).trim() } : null;
}

export interface ChipSpec {
  label: string;
  where: string;
}

// chips="Open now: open | Seafood: tags~sea | ₺–₺₺: price<=2" (or comma-separated)
// chips={[{"label":"Open now","where":"open"}]}. A chip without a label shows its filter.
export function parseChips(v: unknown): ChipSpec[] {
  const entries: unknown[] = Array.isArray(v) ? v : splitLabels(v);
  const out: ChipSpec[] = [];
  for (const x of entries) {
    if (isObj(x)) {
      const where = scalarText(x.where ?? x.filter);
      if (where) out.push({ label: scalarText(x.label) || where, where });
      continue;
    }
    const s = scalarText(x);
    if (!s) continue;
    // "Label: filter" — the label ends at the first ": " (filters never contain one).
    const at = s.indexOf(": ");
    if (at > 0) out.push({ label: s.slice(0, at).trim(), where: s.slice(at + 2).trim() });
    else out.push({ label: s, where: s });
  }
  return out;
}

export interface OptionSpec {
  label: string;
  value: string;
}

// options="Saturday | Sunday" · options={["2 people","4 people"]} · options={[{"label":"Sat","value":"sat"}]}
export function parseOptions(v: unknown): OptionSpec[] {
  if (Array.isArray(v)) {
    return v
      .map((x): OptionSpec | null => {
        if (isObj(x)) {
          const label = scalarText(x.label ?? x.title ?? x.name ?? x.value);
          if (!label) return null;
          return { label, value: x.value === undefined ? label : scalarText(x.value) };
        }
        const s = scalarText(x);
        return s ? { label: s, value: s } : null;
      })
      .filter((o): o is OptionSpec => o !== null);
  }
  return splitLabels(v).map((label) => ({ label, value: label }));
}

export type BestSpec = "auto" | Record<string, "max" | "min">;

// best · best="rating:max price:min distance:min". "auto" = the kit decides per
// column (highest score, lowest price/distance).
export function parseBest(v: unknown): BestSpec | null {
  if (v === true || v === "true" || v === "") return "auto";
  if (v === false || v === "false" || v == null) return null;
  const out: Record<string, "max" | "min"> = {};
  for (const part of splitIds(v)) {
    const [key, dir] = part.split(":");
    if (!key) continue;
    out[key] = dir === "min" ? "min" : "max";
  }
  return Object.keys(out).length ? out : "auto";
}

export interface SortSpec {
  field: string;
  desc: boolean;
}

// sort="rating" ascending · sort="-rating" descending.
export function parseSort(v: unknown): SortSpec | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.startsWith("-") ? { field: s.slice(1).trim(), desc: true } : { field: s, desc: false };
}

export function attrBool(v: unknown, fallback = false): boolean {
  if (v === true || v === "true" || v === "") return true;
  if (v === false || v === "false") return false;
  return fallback;
}

export function attrNum(v: unknown, fallback: number | null = null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) return Number(v);
  return fallback;
}

export function attrText(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

// A {…} attribute (items, values, spark, images) never takes a string, so a string
// names a data key: items="limits" reads data.limits. Anything else is the value.
export function dataRef(v: unknown, data: unknown): unknown {
  return typeof v === "string" && isObj(data) && Object.prototype.hasOwnProperty.call(data, v) ? data[v] : v;
}

function scalarText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
