// catalogPrompt(): the compact catalog reference that goes into the present tool's
// description. Generated from catalog.ts so the docs the model reads never drift
// from what the validator accepts. Deterministic (snapshot-tested).

import {
  COMPONENTS,
  COMPONENT_GROUPS,
  COMPONENT_NAMES,
  GENUI_ICONS,
  GENUI_LIMITS,
  GENUI_TONES,
  type AttrDef,
  type ComponentDef,
  type ComponentGroup,
} from "./catalog.ts";
import { EXPR_FUNCTIONS } from "./expr.ts";

const GROUP_TITLES: Record<ComponentGroup, string> = {
  layout: "Layout",
  content: "Content",
  data: "Data",
  entities: "Entities",
  geo: "Geo",
  inputs: "Inputs",
};

function attrText(name: string, a: AttrDef): string {
  let s = name;
  if (a.kind === "enum" && a.values && !a.brief) s += `=${a.values.join("|")}`;
  else if ((a.kind === "int" || a.kind === "number") && a.min !== undefined && a.max !== undefined && a.max < 1e6) s += `=${a.min}–${a.max}`;
  if (a.required) s += "*";
  if (a.doc) s += ` (${a.doc})`;
  return s;
}

function componentLine(name: string, def: ComponentDef): string {
  const attrs = Object.entries(def.attrs).map(([n, a]) => attrText(n, a));
  if (def.collection) attrs.push("⊂");
  const body = attrs.length ? ` ${attrs.join(" ")}` : "";
  return `${name}${body} — ${def.doc}`;
}

export function catalogPrompt(): string {
  const L = GENUI_LIMITS;
  const lines: string[] = [];
  const push = (...xs: string[]): void => {
    lines.push(...xs);
  };

  push(
    "# present — visual answers",
    "Write the keys in this order: title, tone, icon, replaces, data, actions, ui, summary.",
    `- title ≤ ${L.titleChars} chars. tone (one accent): ${GENUI_TONES.join("|")}. icon: ${GENUI_ICONS.join(" ")}.`,
    "- replaces: id of an earlier view this one updates (it folds to a stub).",
    "- data: each entity once; a collection is an array of objects. ui only references data — never repeat a row in markup.",
    `- actions: {id: {label, kind, primary?, text?, href?, set?}} — send (posts a turn to you; text may template {field} and {state.key}; default = label) · prefill (text → composer) · open (href: URL, file path, maps:{geo}) · copy (text) · set ({stateKey: value}, local). ≤ ${L.primaryActions} primary.`,
    `- ui ≤ ${L.uiBytes / 1024} KB. summary: the answer as plain text ≤ ${L.summaryChars} chars (fallback, notifications, phones).`,
    "",
    "## Entities {type, id, …} — extra fields stay usable in templates",
    "Place: name rating(0–5) reviews price(1–4) geo[lat,lon] address hours{until|closed|text} area cuisine distance",
    "Product: name price currency brand specs inStock · Event: name start end venue geo price · Person: name role org",
    "Article: title author date excerpt · Media: title kind duration · File: path line added removed · Generic: any",
    "All: image (http URL from results, never invented) site (domain → logo) url source (1-based into data.sources) tags[]. Untyped rows need no type/id.",
    "data.sources: [{title, url, site, at, note}] — required when stating facts. Unknown → leave it out.",
    "",
    "## Markup",
    `<Tag a="text" n={3} list={["a","b"]} flag>children</Tag> · <Tag a="x"/>. {…} is JSON, never JS. Text children: inline markdown, no HTML. Depth ≤ ${L.depth}.`,
    '⊂ = takes of="collection" + where= sort="field|-field" limit= skip="ids".',
    'Field attrs (x y cols, Meter value) take a bare name (y="amount"); text attrs read a field only in braces (meta="{cuisine} · {area}"): title="title" prints "title". Omit title/text/meta to show the item\'s own.',
    'Lists: ids "a b" or "a, b"; labels "A | B" or "A, B"; or JSON arrays.',
    "where: open · field · !field · field op value (== != < <= > >= ~contains), joined by &&; value may be state.key.",
    `expr (Value, Progress, when=): arithmetic, comparisons, && || ! ?:; names = state keys, item fields, data (places.rating = all ratings); fns ${EXPR_FUNCTIONS.filter((f) => f !== "fv").join(" ")} fv(payment, annualRate, years).`,
    'Inputs bind="key" to view state. Any element: when="expr", label= (its tab in Tabs). Filters and selection apply to every lens of a collection.',
    "",
    "## Components (* required)",
  );
  for (const group of COMPONENT_GROUPS) {
    const names = COMPONENT_NAMES.filter((n) => (COMPONENTS[n] as ComponentDef).group === group);
    push(`${GROUP_TITLES[group]}:`);
    for (const n of names) push(`- ${componentLine(n, COMPONENTS[n] as ComponentDef)}`);
  }
  push(
    "",
    `Limits: data ≤ ${L.dataBytes / 1024} KB · Carousel ${L.carouselMin}–${L.carouselMax} items · ≤ ${L.maps} Map · ≤ ${L.images} images. A rejected call lists each problem with its path — fix all, call again.`,
  );
  return lines.join("\n");
}
