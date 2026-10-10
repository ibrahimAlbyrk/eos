// The visual-answers catalog: entity, action and component schemas, the limits,
// and validateView — the full check a `present` call passes before it is stored.
// Daemon-side (Zod); the UI reads the dependency-free markup/expr/attrs modules.
//
// Problems are phrased for the model to fix in one more call:
//   data.places[3].rating: 6.2 is outside 0–5
//   ui line 4 <Carousel of="places">: 11 items, max 8 — paginate or filter

import { z } from "zod";
import { parseMarkup, tagLabel, type MarkupElement, type MarkupNode } from "./markup.ts";
import { checkExpr, checkWhere, exprRefs, hasTemplate, matchWhere, parseWhere, whereReadsState } from "./expr.ts";
import { dataRef, parseChips, parseCols, parseOptions, splitIds, splitLabels } from "./attrs.ts";

// ---- enums & limits -----------------------------------------------------------

export const GENUI_TONES = ["blue", "green", "amber", "red", "violet", "teal"] as const;
export const ToneSchema = z.enum(GENUI_TONES);
export type Tone = z.infer<typeof ToneSchema>;

// The icons the kit draws (lucide names).
export const GENUI_ICONS = [
  "utensils", "map", "map-pin", "calendar", "clock", "star", "flask", "git-branch", "chart", "list",
  "check", "alert-triangle", "info", "lightbulb", "book", "plane", "car", "train", "hotel", "coffee",
  "wine", "shopping-bag", "wallet", "user", "users", "file", "folder", "code", "terminal", "bug",
  "rocket", "heart", "sun", "cloud", "music", "film", "globe", "link", "search", "sparkles",
] as const;
export const IconSchema = z.enum(GENUI_ICONS);
export type IconName = z.infer<typeof IconSchema>;

export const GENUI_LIMITS = {
  titleChars: 80,
  summaryChars: 600,
  uiBytes: 24 * 1024,
  dataBytes: 64 * 1024,
  depth: 8,
  carouselMin: 3,
  carouselMax: 8,
  maps: 1,
  images: 40,
  primaryActions: 2,
  actionLabelChars: 60,
  stateBytes: 32 * 1024,
  appHtmlBytes: 256 * 1024,
  appHeightMin: 200,
  appHeightMax: 720,
  tabsMin: 2,
  tabsMax: 6,
} as const;

export const ENTITY_TYPES = ["Place", "Product", "Event", "Person", "Article", "Media", "File", "Generic"] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;
// `type` tags an entity only on an exact name; any other value is an ordinary field of a plain row.
const isEntityType = (v: unknown): v is EntityType => typeof v === "string" && (ENTITY_TYPES as readonly string[]).includes(v);

export const ACTION_KINDS = ["send", "prefill", "open", "copy", "set"] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

// Collection, action and state names: identifiers (any script).
export const GENUI_NAME_RE = /^[\p{L}_][\p{L}\p{N}_-]{0,39}$/u;
export const STATE_KEY_RE = /^[\p{L}_][\p{L}\p{N}_]{0,39}$/u;
const FIELD_RE = /^[\p{L}_$][\p{L}\p{N}_$]*(\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u;
// Names the expression language reserves for its scopes.
const RESERVED_DATA_KEYS = new Set(["item", "state", "data", "true", "false", "null"]);

// The id of a rendered view: v_ + 12 base62 characters.
export const VIEW_ID_RE = /^v_[A-Za-z0-9]{12}$/;

// ---- entities -----------------------------------------------------------------
// Messages that start with "is " follow the offending value: "6.2 is outside 0–5".

// A union whose failure reads as one sentence instead of Zod's "Invalid input".
function oneOf<T extends readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]>(options: T, message: string): z.ZodUnion<T> {
  return z.union(options, {
    errorMap: (iss, ctx) => ({
      message: iss.code === z.ZodIssueCode.invalid_union || iss.code === z.ZodIssueCode.invalid_type ? message : ctx.defaultError,
    }),
  });
}

const UrlSchema = z.string().max(2048).regex(/^https?:\/\/\S+$/i, "must be an http(s) URL");
const SiteSchema = z
  .string()
  .max(253)
  .regex(/^(https?:\/\/)?[\p{L}\p{N}.-]+\.[\p{L}]{2,}(:\d+)?(\/\S*)?$/iu, "must be a domain like example.com");
export const GeoSchema = z.tuple(
  [
    z.number().min(-90, "is not a latitude (−90–90)").max(90, "is not a latitude (−90–90)"),
    z.number().min(-180, "is not a longitude (−180–180)").max(180, "is not a longitude (−180–180)"),
  ],
  {
    errorMap: (iss, ctx) => ({
      message: iss.code === z.ZodIssueCode.invalid_type || iss.code === z.ZodIssueCode.too_small || iss.code === z.ZodIssueCode.too_big
        ? "must be [lat, lon] — two numbers"
        : ctx.defaultError,
    }),
  },
);
export const RatingSchema = z.number().min(0, "is outside 0–5").max(5, "is outside 0–5");
const SourceNumber = z.number().int("is not a source number").min(1, "is not a source number (1 = data.sources[0])");
const SourceRefSchema = oneOf(
  [SourceNumber, z.array(SourceNumber).max(10)],
  "must be a source number ≥ 1 (1 = data.sources[0]) or a list of them",
);
const IdSchema = oneOf([z.string().min(1).max(100), z.number()], "must be a string or number");
const ShortText = (max: number) => z.string().max(max, `is longer than ${max} characters`);
export const HoursSchema = oneOf([
  ShortText(80),
  z
    .object({
      from: ShortText(20).optional(),
      until: ShortText(20).optional(),
      closed: z.boolean().optional(),
      text: ShortText(80).optional(),
    })
    .passthrough(),
], "must be {from, until, closed, text} or short text");

const entityBase = {
  id: IdSchema,
  name: ShortText(200).optional(),
  title: ShortText(200).optional(),
  image: UrlSchema.optional(),
  images: z.array(UrlSchema).max(12).optional(),
  site: SiteSchema.optional(),
  url: UrlSchema.optional(),
  source: SourceRefSchema.optional(),
  tags: z.array(ShortText(60)).max(30).optional(),
  rating: RatingSchema.optional(),
  reviews: z.number().int().min(0, "is not a review count").optional(),
  geo: GeoSchema.optional(),
  address: ShortText(300).optional(),
  status: ShortText(60).optional(),
  meta: ShortText(200).optional(),
  note: ShortText(600).optional(),
};
const Amount = oneOf([z.number(), ShortText(40)], "must be a number or short text");

export const PlaceSchema = z
  .object({
    ...entityBase,
    type: z.literal("Place"),
    price: z.number().int("is not a price level (1–4)").min(1, "is outside 1–4 (price level)").max(4, "is outside 1–4 (price level)").optional(),
    hours: HoursSchema.optional(),
    area: ShortText(100).optional(),
    cuisine: ShortText(100).optional(),
    distance: oneOf([z.number(), ShortText(40)], "must be a number or short text").optional(),
  })
  .passthrough();
export const ProductSchema = z
  .object({
    ...entityBase,
    type: z.literal("Product"),
    price: Amount.optional(),
    currency: ShortText(10).optional(),
    brand: ShortText(100).optional(),
    inStock: z.boolean().optional(),
    specs: z.record(oneOf([z.string(), z.number(), z.boolean()], "must be text, a number or true/false")).optional(),
  })
  .passthrough();
export const EventSchema = z
  .object({
    ...entityBase,
    type: z.literal("Event"),
    start: ShortText(60).optional(),
    end: ShortText(60).optional(),
    venue: ShortText(200).optional(),
    price: Amount.optional(),
  })
  .passthrough();
export const PersonSchema = z
  .object({ ...entityBase, type: z.literal("Person"), role: ShortText(120).optional(), org: ShortText(120).optional() })
  .passthrough();
export const ArticleSchema = z
  .object({
    ...entityBase,
    type: z.literal("Article"),
    author: ShortText(120).optional(),
    date: ShortText(60).optional(),
    excerpt: ShortText(600).optional(),
  })
  .passthrough();
export const MediaSchema = z
  .object({
    ...entityBase,
    type: z.literal("Media"),
    kind: z.enum(["video", "audio", "image", "podcast"]).optional(),
    duration: ShortText(20).optional(),
    date: ShortText(60).optional(),
    author: ShortText(120).optional(),
  })
  .passthrough();
export const FileEntitySchema = z
  .object({
    ...entityBase,
    type: z.literal("File"),
    path: z.string().min(1).max(1024),
    line: z.number().int().min(1, "is not a line number").optional(),
    added: z.number().int().min(0).optional(),
    removed: z.number().int().min(0).optional(),
    lang: ShortText(40).optional(),
  })
  .passthrough();
export const GenericSchema = z.object({ ...entityBase, type: z.literal("Generic") }).passthrough();

export const EntitySchema = z.discriminatedUnion("type", [
  PlaceSchema,
  ProductSchema,
  EventSchema,
  PersonSchema,
  ArticleSchema,
  MediaSchema,
  FileEntitySchema,
  GenericSchema,
]);
export type Entity = z.infer<typeof EntitySchema>;
export type Place = z.infer<typeof PlaceSchema>;

// An untyped row in a collection (chart points, steps, table rows): free-form,
// but the fields every lens reads are still checked.
export const RowSchema = z
  .object({
    id: IdSchema.optional(),
    rating: RatingSchema.optional(),
    geo: GeoSchema.optional(),
    image: UrlSchema.optional(),
    source: SourceRefSchema.optional(),
  })
  .passthrough();

export const SourceSchema = z
  .object({
    title: ShortText(200).optional(),
    name: ShortText(200).optional(),
    url: UrlSchema.optional(),
    site: SiteSchema.optional(),
    at: ShortText(40).optional(),
    note: ShortText(200).optional(),
  })
  .passthrough()
  .refine((s) => Boolean(s.title || s.name || s.url || s.site), "needs a title, url or site");
export type Source = z.infer<typeof SourceSchema>;

// ---- actions ------------------------------------------------------------------

export const ActionSchema = z.object({
  label: z.string().min(1, "is empty").max(GENUI_LIMITS.actionLabelChars, `is longer than ${GENUI_LIMITS.actionLabelChars} characters`),
  kind: ActionKindSchema,
  primary: z.boolean().optional(),
  // send: the turn text (templated: "{name}", "{state.party}"; default: the label).
  // prefill/copy: the text.
  text: z.string().max(4000).optional(),
  // open: an http(s) URL, a file path, or maps:{geo}.
  href: z.string().max(2048).optional(),
  // set: state keys to set locally.
  set: z.record(z.unknown()).optional(),
  icon: IconSchema.optional(),
});
export type Action = z.infer<typeof ActionSchema>;

const HREF_OK = /^(https?:\/\/|maps:|mailto:|tel:|file:\/\/|\/|~\/|\{)/i;

// ---- components ---------------------------------------------------------------

export const COMPONENT_GROUPS = ["layout", "content", "data", "entities", "geo", "inputs"] as const;
export type ComponentGroup = (typeof COMPONENT_GROUPS)[number];

export type AttrKind =
  | "text" // free text; may template item fields: "{cuisine} · {area}"
  | "number"
  | "int"
  | "bool"
  | "enum"
  | "numfield" // a number, or (with of=) the field that holds it
  | "url"
  | "ids" // entity ids: "moda lal"
  | "id" // one entity id
  | "labels" // "A | B" or "A, B" or a JSON array
  | "cols" // "name rating" or "name:Venue, rating:Score"
  | "chips" // "Label: filter, …"
  | "best" // flag, or "rating:max price:min"
  | "json"
  | "collection" // a data collection name
  | "field" // a field name of the collection's items
  | "fields" // one or more field names
  | "actions" // action ids: "book route"
  | "action" // one action id
  | "state" // a state key (inputs bind=)
  | "expr"
  | "where"
  | "sort" // "field" or "-field"
  | "tone"
  | "icon"
  | "geo"; // flag, or [lat, lon]

export interface AttrDef {
  kind: AttrKind;
  required?: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  // Shown in the prompt after the attribute.
  doc?: string;
  // The prompt lists the name only, not the enum values.
  brief?: boolean;
  // Text rendered once per item of of=, so "{field}" reads that item's field.
  item?: boolean;
}

export type ChildPolicy = "none" | "text" | "nodes" | "raw" | "items";

export interface ComponentDef {
  group: ComponentGroup;
  doc: string;
  attrs: Record<string, AttrDef>;
  children: ChildPolicy;
  // "required": of= must name a collection; "optional": of= or another source.
  // Either way the element also takes where / sort / limit / skip.
  collection?: "required" | "optional";
  // At least one attribute of each group must be present (children count as "children").
  needs?: readonly (readonly string[])[];
}

const t = (doc?: string): AttrDef => ({ kind: "text", doc });
const ti = (doc?: string): AttrDef => ({ kind: "text", item: true, doc });
const req = (a: AttrDef): AttrDef => ({ ...a, required: true });
const en = (values: readonly string[], doc?: string): AttrDef => ({ kind: "enum", values, doc });
const int = (min: number, max: number, doc?: string): AttrDef => ({ kind: "int", min, max, doc });
const num = (min?: number, max?: number, doc?: string): AttrDef => ({ kind: "number", min, max, doc });
const flag = (doc?: string): AttrDef => ({ kind: "bool", doc });
const k = (kind: AttrKind, doc?: string): AttrDef => ({ kind, doc });

const GAP = ["sm", "md", "lg"] as const;
const ALIGN = ["start", "center", "end", "stretch"] as const;
const SIZE = ["sm", "md", "lg"] as const;

// Every element also takes these.
export const GLOBAL_ATTRS: Record<string, AttrDef> = {
  label: t("its tab label inside Tabs"),
  when: k("expr", "render only while true"),
};

// Collection elements also take these.
export const COLLECTION_ATTRS: Record<string, AttrDef> = {
  where: k("where"),
  sort: k("sort"),
  limit: int(1, 100),
  skip: k("ids"),
};

export const COMPONENTS = {
  // Layout
  Section: {
    group: "layout",
    doc: "titled group",
    attrs: { title: t(), meta: t(), icon: k("icon"), collapsed: flag() },
    children: "nodes",
  },
  Stack: {
    group: "layout",
    doc: "vertical flow, or a row",
    attrs: { gap: en(GAP), dir: en(["col", "row"]), align: en(ALIGN), wrap: flag() },
    children: "nodes",
  },
  Grid: {
    group: "layout",
    doc: "columns; reflows when narrow",
    attrs: { cols: int(1, 4), gap: en(GAP), min: int(120, 480, "px") },
    children: "nodes",
  },
  Split: {
    group: "layout",
    doc: "two children side by side; stacks when narrow",
    attrs: { ratio: en(["1:1", "1:2", "2:1", "2:3", "3:2"]), align: { ...en(ALIGN), brief: true } },
    children: "nodes",
  },
  Carousel: {
    group: "layout",
    doc: "3–8 cards scrolling sideways, from of= or child elements",
    attrs: { of: k("collection"), card: en(["row", "compact", "hero"]), meta: ti(), actions: k("actions") },
    children: "nodes",
    collection: "optional",
    needs: [["of", "children"]],
  },
  Tabs: {
    group: "layout",
    doc: "segmented switch between child elements (each child's label=)",
    attrs: { bind: k("state"), labels: k("labels") },
    children: "nodes",
  },
  Disclosure: {
    group: "layout",
    doc: "row that expands to show its children",
    attrs: { title: req(t()), meta: t(), badge: t(), tone: k("tone"), icon: k("icon"), open: flag() },
    children: "nodes",
  },
  Divider: { group: "layout", doc: "hairline; label= puts text on it", attrs: {}, children: "none" },

  // Content
  Text: {
    group: "content",
    doc: "inline-markdown paragraph",
    attrs: { size: en(SIZE), tone: k("tone"), muted: flag() },
    children: "text",
  },
  Heading: {
    group: "content",
    doc: "heading",
    attrs: { level: int(1, 3), meta: t(), icon: k("icon") },
    children: "text",
  },
  Image: {
    group: "content",
    doc: "one image",
    attrs: {
      src: req(k("url")),
      alt: t(),
      ratio: en(["16:9", "4:3", "3:2", "1:1", "21:9"]),
      credit: t(),
      fit: en(["cover", "contain"]),
    },
    children: "none",
  },
  Gallery: {
    group: "content",
    doc: "several images, +N tile",
    attrs: { of: k("collection"), field: k("field"), images: k("json", "URLs"), layout: en(["bento", "grid", "strip"]) },
    children: "none",
    collection: "optional",
    needs: [["of", "images"]],
  },
  Logo: {
    group: "content",
    doc: "brand logo → site icon → monogram",
    attrs: { site: t(), name: t(), size: en(SIZE) },
    children: "none",
    needs: [["site", "name"]],
  },
  Badge: {
    group: "content",
    doc: "short tag",
    attrs: { tone: k("tone"), icon: k("icon"), variant: en(["soft", "solid", "outline"]) },
    children: "text",
  },
  Rating: {
    group: "content",
    doc: "★ value (count)",
    attrs: { value: req(num(0, 5)), count: int(0, 1e9), source: int(1, 100) },
    children: "none",
  },
  Price: {
    group: "content",
    doc: "price level (₺₺) or an amount",
    attrs: { level: int(1, 4), amount: t(), currency: t(), per: t() },
    children: "none",
    needs: [["level", "amount"]],
  },
  Status: {
    group: "content",
    doc: "colored dot + text",
    attrs: {
      state: req(en(["open", "closing", "closed", "ok", "warn", "error", "info", "running", "idle"])),
      until: t(),
    },
    children: "text",
  },
  Callout: {
    group: "content",
    doc: "highlighted note; action= adds its button",
    attrs: { kind: en(["info", "tip", "warning", "danger", "success"]), title: t(), icon: k("icon"), action: k("action") },
    children: "text",
  },
  Quote: { group: "content", doc: "quotation", attrs: { cite: t(), source: int(1, 100) }, children: "text" },
  Code: {
    group: "content",
    doc: "code block: raw text child, or value= from a template",
    attrs: { lang: t(), title: t(), value: t(), wrap: flag() },
    children: "raw",
  },
  FileRef: {
    group: "content",
    doc: "file chip that opens in the side panel",
    attrs: { path: req(t()), line: int(1, 1e7) },
    children: "none",
  },
  Sources: {
    group: "content",
    doc: "numbered sources (default of=sources)",
    attrs: { of: k("collection"), compact: flag() },
    children: "none",
  },

  // Data
  Stat: {
    group: "data",
    doc: "KPI tile; spark= draws a sparkline under it; delta is coloured only with good= (the direction that is good news)",
    attrs: { label: req(t()), value: req(t()), meta: t(), delta: t(), trend: en(["up", "down", "flat"]), good: en(["up", "down"]), tone: k("tone"), icon: k("icon"), spark: k("json", "number list"), source: int(1, 100) },
    children: "none",
  },
  KeyValue: {
    group: "data",
    doc: "label/value rows",
    attrs: { of: k("collection"), items: k("json", "{\"Label\":\"value\"}"), key: ti(), value: ti(), cols: int(1, 2) },
    children: "none",
    collection: "optional",
    needs: [["of", "items"]],
  },
  Table: {
    group: "data",
    doc: "sortable compare table; a row selects its entity in every lens",
    attrs: { of: req(k("collection")), cols: req(k("cols")), best: k("best"), numbered: flag(), actions: k("actions") },
    children: "none",
    collection: "required",
  },
  Chart: {
    group: "data",
    doc: "chart from rows (x field, y field(s)) or values",
    attrs: {
      type: req(en(["bar", "line", "area", "donut", "sparkline"])),
      of: k("collection"),
      x: k("field"),
      y: k("fields"),
      values: k("json", "number list"),
      unit: t(),
      height: int(60, 400),
      stacked: flag(),
    },
    children: "none",
    collection: "optional",
    needs: [["of", "values"]],
  },
  Meter: {
    group: "data",
    doc: "bar meter; with of= one per item and value= names the field",
    attrs: { value: req(k("numfield")), max: num(), label: ti(), unit: t(), tone: k("tone"), of: k("collection") },
    children: "none",
    collection: "optional",
  },
  Timeline: {
    group: "data",
    doc: "time-ordered stops or events",
    attrs: { of: req(k("collection")), time: ti(), title: ti(), note: ti(), meta: ti(), leg: ti("to next"), numbered: flag() },
    children: "none",
    collection: "required",
  },
  Steps: {
    group: "data",
    doc: "ordered steps; stepper shows one at a time with Back/Next",
    attrs: { of: k("collection"), variant: en(["list", "stepper"]), bind: k("state"), title: ti(), text: ti(), code: ti() },
    children: "nodes",
    collection: "optional",
    needs: [["of", "children"]],
  },
  Progress: {
    group: "data",
    doc: "progress bar",
    attrs: { value: num(), max: num(), expr: k("expr"), label: t(), tone: k("tone") },
    children: "none",
    needs: [["value", "expr"]],
  },
  Value: {
    group: "data",
    doc: "live computed number",
    attrs: {
      expr: req(k("expr")),
      label: t(),
      format: en(["number", "int", "currency", "percent", "compact"]),
      prefix: t(),
      suffix: t(),
      decimals: int(0, 6),
      currency: t(),
      tone: k("tone"),
      size: en(SIZE),
    },
    children: "none",
  },

  // Entities
  Card: {
    group: "entities",
    doc: "one entity",
    attrs: {
      of: req(k("collection")),
      pick: req(k("id")),
      variant: en(["row", "compact", "hero"]),
      kind: { ...en(ENTITY_TYPES, "entity type"), brief: true },
      meta: ti(),
      badge: ti(),
      actions: k("actions"),
    },
    children: "none",
  },
  Hero: {
    group: "entities",
    doc: "the top pick, large; children say why",
    attrs: { of: req(k("collection")), pick: req(k("id")), badge: ti(), meta: ti(), actions: k("actions"), gallery: flag() },
    children: "text",
  },
  List: {
    group: "entities",
    doc: "a row per item; child elements repeat per item (a disclosure row's detail)",
    attrs: {
      of: req(k("collection")),
      variant: en(["row", "compact", "disclosure"]),
      title: ti(),
      meta: ti(),
      badge: ti(),
      tone: k("tone"),
      numbered: flag(),
      actions: k("actions"),
    },
    children: "items",
    collection: "required",
  },

  // Geo
  Map: {
    group: "geo",
    doc: "pins from geo or address; route joins them in order; you = the user",
    attrs: { of: req(k("collection")), pin: en(["index", "dot", "logo"]), route: flag(), you: k("geo"), height: int(160, 600), zoom: num(1, 19) },
    children: "none",
    collection: "required",
  },

  // Inputs
  Filters: {
    group: "inputs",
    doc: "chips filtering a collection in every lens",
    attrs: { of: req(k("collection")), chips: req(k("chips")), on: k("labels", "initially on"), bind: k("state") },
    children: "none",
  },
  Segmented: {
    group: "inputs",
    doc: "one of 2–5 options",
    attrs: { bind: req(k("state")), options: req(k("labels")), default: t() },
    children: "none",
  },
  Toggle: { group: "inputs", doc: "on/off", attrs: { bind: req(k("state")), label: t(), default: flag() }, children: "none" },
  Slider: {
    group: "inputs",
    doc: "number in a range",
    attrs: {
      bind: req(k("state")),
      min: req(num()),
      max: req(num()),
      step: num(),
      default: num(),
      label: t(),
      prefix: t(),
      suffix: t(),
      format: { ...en(["number", "int", "currency", "percent", "compact"], "as Value"), brief: true },
    },
    children: "none",
  },
  Stepper: {
    group: "inputs",
    doc: "− n +",
    attrs: { bind: req(k("state")), min: num(), max: num(), step: num(), default: num(), label: t(), unit: t() },
    children: "none",
  },
  Select: {
    group: "inputs",
    doc: "dropdown",
    attrs: { bind: req(k("state")), options: req(k("labels")), default: t(), label: t() },
    children: "none",
  },
  Field: {
    group: "inputs",
    doc: "text input",
    attrs: { bind: req(k("state")), label: t(), placeholder: t(), type: en(["text", "number", "date", "time", "multiline"]), default: t() },
    children: "none",
  },
  Checklist: {
    group: "inputs",
    doc: "tick list with a done count",
    attrs: { bind: req(k("state")), of: k("collection"), items: k("labels"), title: t(), text: ti() },
    children: "none",
    collection: "optional",
    needs: [["of", "items"]],
  },
  Choice: {
    group: "inputs",
    doc: "quiz or poll; answer= reveals right/wrong locally; children = the question",
    attrs: { bind: req(k("state")), options: req(k("labels")), question: t(), answer: t("index or label"), explain: t(), action: k("action") },
    children: "text",
  },
  Form: {
    group: "inputs",
    doc: "groups inputs; submit sends the action with their values",
    attrs: { action: req(k("action")), submit: t() },
    children: "nodes",
  },
  Actions: {
    group: "inputs",
    doc: "buttons for actions",
    attrs: { ids: req(k("actions")), align: en(["start", "end", "stretch"]) },
    children: "none",
  },
} as const satisfies Record<string, ComponentDef>;

export type ComponentName = keyof typeof COMPONENTS;
export const COMPONENT_NAMES = Object.keys(COMPONENTS) as ComponentName[];
const COMPONENT_DEFS: Record<string, ComponentDef> = COMPONENTS;

export function isComponentName(name: string): name is ComponentName {
  return Object.prototype.hasOwnProperty.call(COMPONENTS, name);
}

// Every attribute a component accepts (its own, collection, global).
export function componentAttrs(name: ComponentName): Record<string, AttrDef> {
  const def = COMPONENT_DEFS[name];
  return { ...GLOBAL_ATTRS, ...(def.collection ? COLLECTION_ATTRS : {}), ...def.attrs };
}

// ---- attribute schemas ---------------------------------------------------------

const TEMPLATABLE: ReadonlySet<AttrKind> = new Set(["text", "number", "int", "bool", "enum", "numfield", "url", "id", "tone", "icon"]);
const TemplateString = z.string().refine(hasTemplate);
const NUM_RE = /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
const ListValue = oneOf([z.string(), z.number(), z.array(z.unknown())], "must be a list");

function rangeText(a: AttrDef): string {
  const lo = a.min ?? -Infinity;
  const hi = a.max ?? Infinity;
  return Number.isFinite(lo) && Number.isFinite(hi) ? `${lo}–${hi}` : Number.isFinite(lo) ? `≥ ${lo}` : `≤ ${hi}`;
}

function numberSchema(a: AttrDef, integer: boolean): z.ZodTypeAny {
  return oneOf([z.number(), z.string().regex(NUM_RE, "is not a number")], "is not a number")
    .transform((v) => (typeof v === "number" ? v : Number(v)))
    .superRefine((n, ctx) => {
      if (integer && !Number.isInteger(n)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "is not a whole number" });
      else if ((a.min !== undefined && n < a.min) || (a.max !== undefined && n > a.max)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `is outside ${rangeText(a)}` });
      }
    });
}

function enumSchema(values: readonly string[]): z.ZodTypeAny {
  const lower = new Set(values.map((v) => v.toLowerCase()));
  return z.string({ invalid_type_error: `is not one of ${values.join(", ")}` }).refine((v) => lower.has(v.toLowerCase()), `is not one of ${values.join(", ")}`);
}

function baseAttrSchema(a: AttrDef): z.ZodTypeAny {
  switch (a.kind) {
    case "text":
      return oneOf([z.string(), z.number(), z.boolean()], "must be text");
    case "number":
      return numberSchema(a, false);
    case "int":
      return numberSchema(a, true);
    case "numfield":
      return oneOf([z.number(), z.string().min(1, "must be a number or a field name")], "must be a number or a field name");
    case "bool":
      return oneOf([z.boolean(), z.enum(["true", "false"])], "is not true or false");
    case "enum":
      return enumSchema(a.values ?? []);
    case "url":
      return z.string({ invalid_type_error: "must be an http(s) URL" }).regex(/^https?:\/\/\S+$/i, "must be an http(s) URL");
    case "ids":
    case "labels":
    case "cols":
    case "chips":
    case "fields":
    case "actions":
      return ListValue;
    case "id":
      return oneOf([z.string().min(1, "must be an id"), z.number()], "must be an id");
    case "best":
      return oneOf([z.boolean(), z.string()], 'must be a flag or "field:max field:min"');
    case "json":
      return z.unknown();
    case "collection":
      return z.string({ invalid_type_error: "must name a data collection" }).regex(GENUI_NAME_RE, "must name a data collection");
    case "field":
      return z.string({ invalid_type_error: "must be a field name" }).regex(FIELD_RE, "must be a field name");
    case "action":
      return z.string({ invalid_type_error: "must name an action" }).regex(GENUI_NAME_RE, "must name an action");
    case "state":
      return z.string({ invalid_type_error: "must be a state key" }).regex(STATE_KEY_RE, "must be a state key like party_size");
    case "expr":
      return z.string({ invalid_type_error: "must be an expression" }).superRefine((v, ctx) => {
        const e = checkExpr(v);
        if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `is not a valid expression: ${e}` });
      });
    case "where":
      return z.string({ invalid_type_error: "must be a filter" }).superRefine((v, ctx) => {
        const e = checkWhere(v);
        if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `is not a valid filter: ${e}` });
      });
    case "sort":
      return z.string({ invalid_type_error: "must be a field name" }).regex(/^-?\s*[\p{L}_$][\p{L}\p{N}_$.]*$/u, "must be field or -field");
    case "tone":
      return enumSchema(GENUI_TONES);
    case "icon":
      return enumSchema(GENUI_ICONS);
    case "geo":
      return oneOf([z.boolean(), z.enum(["true", "false"]), GeoSchema], "must be a flag or [lat, lon]");
    default:
      return z.unknown();
  }
}

const baseCache = new WeakMap<AttrDef, z.ZodTypeAny>();

function cachedBase(a: AttrDef): z.ZodTypeAny {
  let s = baseCache.get(a);
  if (!s) {
    s = baseAttrSchema(a);
    baseCache.set(a, s);
  }
  return s;
}

export function attrSchema(a: AttrDef): z.ZodTypeAny {
  const base = cachedBase(a);
  return TEMPLATABLE.has(a.kind) ? z.union([TemplateString, base]) : base;
}

function buildComponentSchema(name: ComponentName): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [attr, def] of Object.entries(componentAttrs(name))) {
    const s = attrSchema(def);
    shape[attr] = def.required ? s : s.optional();
  }
  return z.object(shape).passthrough();
}

// One Zod schema per component over its parsed attributes (strings, JSON values,
// `true` for flags). Unknown attributes pass through; validateView warns on them.
export const COMPONENT_SCHEMAS: Record<ComponentName, z.ZodTypeAny> = Object.fromEntries(
  COMPONENT_NAMES.map((n) => [n, buildComponentSchema(n)]),
) as Record<ComponentName, z.ZodTypeAny>;

// ---- validation ---------------------------------------------------------------

export interface ViewProblem {
  path: string;
  message: string;
}

export interface CollectionStat {
  name: string;
  count: number;
  // The entity type most items share; null for untyped rows.
  type: EntityType | null;
}

export interface ViewStats {
  uiBytes: number;
  dataBytes: number;
  elements: number;
  depth: number;
  components: string[];
  collections: CollectionStat[];
  images: number;
  sites: number;
  maps: number;
  primaryActions: number;
}

export type ViewValidation =
  | { ok: true; warnings: ViewProblem[]; stats: ViewStats }
  | { ok: false; problems: ViewProblem[]; warnings: ViewProblem[] };

export const PRESENT_KEYS = ["title", "tone", "icon", "replaces", "data", "actions", "ui", "summary"] as const;

export function formatProblem(p: ViewProblem): string {
  return `${p.path}: ${p.message}`;
}

// The text a rejected call returns to the model.
export function formatProblems(problems: readonly ViewProblem[]): string {
  const head = `${problems.length} problem${problems.length === 1 ? "" : "s"} — nothing rendered`;
  return [head, ...problems.map((p) => `· ${formatProblem(p)}`), "fix and call present again"].join("\n");
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v);
  if (v === undefined) return "missing";
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 39)}…` : s;
  } catch {
    return String(v);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function dataPath(base: string, path: readonly (string | number)[]): string {
  let out = base;
  for (const seg of path) out += typeof seg === "number" ? `[${seg}]` : /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
  return out;
}

function getAt(root: unknown, path: readonly (string | number)[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

const ARTICLE: Record<string, string> = { array: "a list", object: "an object", string: "text", number: "a number", boolean: "true or false", integer: "a whole number" };

// One Zod issue → one model-readable problem at `base` + the issue path.
function issueProblems(base: string, root: unknown, err: z.ZodError): ViewProblem[] {
  const out: ViewProblem[] = [];
  const seen = new Set<string>();
  for (const issue of err.issues) {
    const path = dataPath(base, issue.path);
    const value = getAt(root, issue.path);
    let message: string;
    if (value === undefined && (issue.code === z.ZodIssueCode.invalid_type || issue.code === z.ZodIssueCode.invalid_union)) {
      message = "is required";
      const key = `${path}|${message}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ path, message });
      }
      continue;
    }
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type:
        message =
          issue.received === "undefined"
            ? `is required (${ARTICLE[issue.expected] ?? issue.expected})`
            : issue.message.startsWith("Expected")
              ? `must be ${ARTICLE[issue.expected] ?? issue.expected}, got ${show(value)}`
              : withValue(issue.message, value);
        break;
      case z.ZodIssueCode.invalid_enum_value:
        message = `${show(value)} is not one of ${issue.options.join(", ")}`;
        break;
      case z.ZodIssueCode.invalid_literal:
        message = `${show(value)} must be ${show(issue.expected)}`;
        break;
      case z.ZodIssueCode.invalid_union_discriminator:
        message = `${show(value)} is not an entity type — use one of ${issue.options.map(String).join(", ")}`;
        break;
      case z.ZodIssueCode.too_small:
        message = issue.message.startsWith("is ") || issue.message.startsWith("must")
          ? withValue(issue.message, value)
          : issue.type === "string"
            ? "is empty"
            : issue.type === "array"
              ? `must have at least ${issue.minimum} item${issue.minimum === 1 ? "" : "s"}`
              : withValue(`is below ${issue.minimum}`, value);
        break;
      case z.ZodIssueCode.too_big:
        message = issue.message.startsWith("is ") || issue.message.startsWith("must")
          ? withValue(issue.message, value)
          : issue.type === "array"
            ? `has more than ${issue.maximum} items`
            : issue.type === "string"
              ? `is longer than ${issue.maximum} characters`
              : withValue(`is above ${issue.maximum}`, value);
        break;
      default:
        message = withValue(issue.message, value);
    }
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, message });
  }
  return out;
}

function withValue(message: string, value: unknown): string {
  return message.startsWith("is ") ? `${value === undefined ? "value" : show(value)} ${message}` : message;
}

interface DataInfo {
  collections: Map<string, Record<string, unknown>[]>;
  keys: Set<string>;
  // The data object itself, for {…} attributes that name a key (items="limits").
  raw: Record<string, unknown>;
  ids: Map<string, Set<string>>;
  images: Set<string>;
  sites: Set<string>;
  sourcesCount: number;
}

function validateData(data: unknown, problems: ViewProblem[], warnings: ViewProblem[]): DataInfo {
  const info: DataInfo = { collections: new Map(), keys: new Set(), raw: {}, ids: new Map(), images: new Set(), sites: new Set(), sourcesCount: 0 };
  if (data === undefined) return info;
  if (!isObj(data)) {
    problems.push({ path: "data", message: `must be an object of collections, got ${show(data)}` });
    return info;
  }
  info.raw = data;
  let bytes: number;
  try {
    bytes = utf8Bytes(JSON.stringify(data));
  } catch {
    problems.push({ path: "data", message: "is not plain JSON" });
    return info;
  }
  if (bytes > GENUI_LIMITS.dataBytes) {
    problems.push({ path: "data", message: `is ${kb(bytes)}, max ${kb(GENUI_LIMITS.dataBytes)} — trim fields or items` });
  }
  const sources = data.sources;
  if (sources !== undefined) {
    if (!Array.isArray(sources)) {
      problems.push({ path: "data.sources", message: "must be a list of {title, url, site, at, note}" });
    } else {
      sources.forEach((s, i) => {
        const r = SourceSchema.safeParse(s);
        if (!r.success) problems.push(...issueProblems(`data.sources[${i}]`, s, r.error));
      });
      info.sourcesCount = sources.length;
    }
  }
  for (const [key, value] of Object.entries(data)) {
    info.keys.add(key);
    if (!GENUI_NAME_RE.test(key)) {
      problems.push({ path: dataPath("data", [key]), message: "is not a usable name — letters, digits, _ or -, starting with a letter" });
      continue;
    }
    if (RESERVED_DATA_KEYS.has(key)) {
      problems.push({ path: `data.${key}`, message: `"${key}" is reserved by expressions — rename it` });
      continue;
    }
    if (!Array.isArray(value)) continue;
    if (key === "sources") {
      const list = value.filter(isObj);
      info.collections.set(key, list);
      info.ids.set(key, new Set(list.filter((x) => x.id !== undefined).map((x) => String(x.id))));
      continue;
    }
    const objects = value.filter(isObj).length;
    if (objects === 0) continue; // a list of values (labels, numbers) — a scalar, not a collection
    if (objects !== value.length) {
      const bad = value.findIndex((x) => !isObj(x));
      problems.push({ path: `data.${key}[${bad}]`, message: `${show(value[bad])} — a collection holds objects only` });
      continue;
    }
    const items = value as Record<string, unknown>[];
    info.collections.set(key, items);
    const ids = new Set<string>();
    const hasEntity = items.some((x) => isEntityType(x.type));
    items.forEach((item, i) => {
      const path = `data.${key}[${i}]`;
      if (isEntityType(item.type)) {
        const r = EntitySchema.safeParse(item);
        if (!r.success) problems.push(...issueProblems(path, item, r.error));
        if (item.type !== "File" && item.name === undefined && item.title === undefined) {
          warnings.push({ path, message: "has no name or title — cards show its id" });
        }
      } else {
        // A `type` that names no entity is an ordinary field (commit kinds, file/dir); only among entity rows is it likely a typo.
        if (hasEntity && typeof item.type === "string") {
          warnings.push({
            path: `${path}.type`,
            message: `${show(item.type)} is not an entity type — this row is read as a plain row; use one of ${ENTITY_TYPES.join(", ")} or rename the field`,
          });
        }
        const r = RowSchema.safeParse(item);
        if (!r.success) problems.push(...issueProblems(path, item, r.error));
      }
      if (item.id !== undefined && (typeof item.id === "string" || typeof item.id === "number")) {
        const id = String(item.id);
        if (ids.has(id)) problems.push({ path: `${path}.id`, message: `${show(item.id)} repeats an earlier id in ${key} — ids must be unique` });
        ids.add(id);
      }
      if (typeof item.image === "string") info.images.add(item.image);
      if (Array.isArray(item.images)) for (const u of item.images) if (typeof u === "string") info.images.add(u);
      if (typeof item.site === "string") info.sites.add(item.site.toLowerCase());
      const refs = typeof item.source === "number" ? [item.source] : Array.isArray(item.source) ? item.source : [];
      for (const n of refs) {
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
        if (n > info.sourcesCount) {
          problems.push({
            path: `${path}.source`,
            message: info.sourcesCount
              ? `${n} but data.sources has ${info.sourcesCount} — source is 1-based (1 = data.sources[0])`
              : `${n} but data has no sources — add data.sources [{title, url, at}]`,
          });
        }
      }
    });
    info.ids.set(key, ids);
  }
  return info;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
}

interface ActionInfo {
  ids: Set<string>;
  kinds: Map<string, ActionKind>;
  setKeys: Set<string>;
  primary: number;
  // {state.key} holes in action text/href, checked once every bind= is known.
  stateRefs: { path: string; key: string }[];
}

const STATE_HOLE_RE = /\{\s*state\.([\p{L}_][\p{L}\p{N}_]*)/gu;

function validateActions(actions: unknown, problems: ViewProblem[], warnings: ViewProblem[]): ActionInfo {
  const out: ActionInfo = { ids: new Set(), kinds: new Map(), setKeys: new Set(), primary: 0, stateRefs: [] };
  if (actions === undefined) return out;
  if (!isObj(actions)) {
    problems.push({ path: "actions", message: `must be an object of {id: {label, kind, …}}, got ${show(actions)}` });
    return out;
  }
  const primary: string[] = [];
  for (const [id, raw] of Object.entries(actions)) {
    const path = dataPath("actions", [id]);
    out.ids.add(id);
    if (!GENUI_NAME_RE.test(id)) {
      problems.push({ path, message: "is not a usable action id — letters, digits, _ or -" });
      continue;
    }
    const r = ActionSchema.safeParse(raw);
    if (!r.success) {
      problems.push(...issueProblems(path, raw, r.error));
      continue;
    }
    const a = r.data;
    out.kinds.set(id, a.kind);
    if (isObj(raw)) {
      for (const extra of Object.keys(raw)) {
        if (!(extra in ActionSchema.shape)) warnings.push({ path: `${path}.${extra}`, message: "is not an action field — ignored" });
      }
    }
    if (a.primary) primary.push(id);
    for (const field of ["text", "href"] as const) {
      for (const m of (a[field] ?? "").matchAll(STATE_HOLE_RE)) out.stateRefs.push({ path: `${path}.${field}`, key: m[1] });
    }
    if ((a.kind === "prefill" || a.kind === "copy") && !a.text) problems.push({ path: `${path}.text`, message: `is required for kind "${a.kind}"` });
    if (a.kind === "open") {
      if (!a.href) problems.push({ path: `${path}.href`, message: 'is required for kind "open" (a URL, file path or maps:{geo})' });
      else if (!HREF_OK.test(a.href.trim())) {
        problems.push({ path: `${path}.href`, message: `${show(a.href)} must be an http(s) URL, a file path, maps:, mailto: or tel:` });
      }
    }
    if (a.kind === "set") {
      if (!a.set || !Object.keys(a.set).length) problems.push({ path: `${path}.set`, message: 'is required for kind "set" — {stateKey: value}' });
      else for (const key of Object.keys(a.set)) out.setKeys.add(key);
    }
  }
  out.primary = primary.length;
  if (primary.length > GENUI_LIMITS.primaryActions) {
    problems.push({
      path: "actions",
      message: `${primary.length} are primary (${primary.join(", ")}), max ${GENUI_LIMITS.primaryActions} — keep the main one or two`,
    });
  }
  return out;
}

interface UiContext {
  data: DataInfo;
  actions: ActionInfo;
  problems: ViewProblem[];
  warnings: ViewProblem[];
  binds: Set<string>;
  images: Set<string>;
  maps: number;
  elements: number;
  depth: number;
  components: Set<string>;
  // Deferred checks that need every bind= first.
  exprChecks: { path: string; expr: string; inItem: boolean }[];
}

function uiPath(el: MarkupElement): string {
  return `ui line ${el.pos.line} ${tagLabel(el)}`;
}

function collectionNames(ctx: UiContext): string {
  const names = [...ctx.data.collections.keys()];
  return names.length ? `collections: ${names.join(", ")}` : "data has no collections";
}

function listIds(ids: Set<string>): string {
  const all = [...ids];
  return all.length > 10 ? `${all.slice(0, 10).join(", ")}, …` : all.join(", ");
}

function staticCount(items: Record<string, unknown>[], el: MarkupElement, ids: Set<string>): number {
  let list = items;
  const where = el.attrs.where;
  if (typeof where === "string") {
    const r = parseWhere(where);
    if (r.ok && !whereReadsState(r.node)) list = list.filter((it) => matchWhere(it, r.node));
  }
  const skip = new Set(splitIds(el.attrs.skip).filter((id) => ids.has(id)));
  if (skip.size) list = list.filter((it) => !skip.has(String(it.id)));
  let n = list.length;
  const limit = Number(el.attrs.limit);
  if (Number.isFinite(limit) && limit > 0) n = Math.min(n, limit);
  return n;
}

function fieldsOf(items: Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) for (const key of Object.keys(it)) out.add(key);
  return out;
}

function visitElement(ctx: UiContext, el: MarkupElement, depth: number, inItem: boolean): void {
  ctx.elements++;
  if (depth > ctx.depth) ctx.depth = depth;
  const path = uiPath(el);
  if (depth === GENUI_LIMITS.depth + 1) {
    ctx.problems.push({ path, message: `is nested ${depth} deep, max ${GENUI_LIMITS.depth} — flatten the layout` });
  }
  if (!isComponentName(el.name)) {
    const hint = /^[a-z]/.test(el.name) ? " (text is markdown — use **bold**, not HTML)" : "";
    ctx.problems.push({ path, message: `unknown component${hint} — use one of ${COMPONENT_NAMES.join(", ")}` });
    for (const c of el.children) if (c.type === "element") visitElement(ctx, c, depth + 1, inItem);
    return;
  }
  const name = el.name;
  ctx.components.add(name);
  const def: ComponentDef = COMPONENT_DEFS[name];
  const attrs = componentAttrs(name);

  for (const [attr, value] of Object.entries(el.attrs)) {
    const a = attrs[attr];
    if (!a) {
      ctx.warnings.push({ path: `${path}.${attr}`, message: `is not an attribute of <${name}> — ignored` });
      continue;
    }
    if (TEMPLATABLE.has(a.kind) && hasTemplate(value)) continue;
    const r = cachedBase(a).safeParse(value);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? "is not valid";
      ctx.problems.push({ path: `${path}.${attr}`, message: withValue(msg.startsWith("is ") || msg.startsWith("must") ? msg : `is not valid: ${msg}`, value) });
    }
  }
  for (const [attr, a] of Object.entries(attrs)) {
    if (a.required && el.attrs[attr] === undefined) ctx.problems.push({ path, message: `needs ${attr}=` });
  }
  const elementChildren = el.children.filter((c): c is MarkupElement => c.type === "element");
  const hasText = el.children.some((c) => c.type === "text");
  for (const group of def.needs ?? []) {
    const present = group.some((g) => (g === "children" ? elementChildren.length > 0 : el.attrs[g] !== undefined));
    if (!present) ctx.problems.push({ path, message: `needs ${group.map((g) => (g === "children" ? "child elements" : `${g}=`)).join(" or ")}` });
  }

  // Children.
  if (def.children === "none" && (elementChildren.length || hasText)) {
    ctx.warnings.push({ path, message: `takes no children — write <${name} …/>; its content is ignored` });
  } else if (def.children === "text" && elementChildren.length) {
    ctx.warnings.push({ path, message: `shows text only — ${elementChildren.map((c) => `<${c.name}>`).join(", ")} inside it is ignored` });
  }

  // Data references.
  const of = typeof el.attrs.of === "string" ? el.attrs.of : name === "Sources" ? "sources" : undefined;
  let items: Record<string, unknown>[] | undefined;
  let ids = new Set<string>();
  if (of !== undefined) {
    if (name === "Sources") {
      if (of === "sources" && !ctx.data.keys.has("sources")) ctx.problems.push({ path, message: "data has no sources — add data.sources [{title, url, at}]" });
      else if (of !== "sources" && !ctx.data.collections.has(of)) ctx.problems.push({ path, message: `data has no collection "${of}" — ${collectionNames(ctx)}` });
    } else if (!ctx.data.collections.has(of)) {
      const why = ctx.data.keys.has(of) ? `data.${of} is not a list of objects` : `data has no collection "${of}"`;
      const hint = isObj(dataRef(of, ctx.data.raw)) ? ` — for label/value rows write <KeyValue items="${of}"/>` : "";
      ctx.problems.push({ path, message: `${why} — ${collectionNames(ctx)}${hint}` });
    } else {
      items = ctx.data.collections.get(of);
      ids = ctx.data.ids.get(of) ?? new Set();
    }
  }
  for (const [attr, a] of Object.entries(attrs)) {
    const v = el.attrs[attr];
    if (a.kind === "json" && typeof v === "string") checkDataRef(ctx, `${path}.${attr}`, attr, a, v);
  }

  if (items) {
    for (const attr of ["pick"] as const) {
      const v = el.attrs[attr];
      if (v === undefined || hasTemplate(v)) continue;
      if (!ids.has(String(v))) {
        ctx.problems.push({ path: `${path}.${attr}`, message: `${show(v)} is not an id in ${of} — ids: ${listIds(ids) || "none (give items an id)"}` });
      }
    }
    for (const id of splitIds(el.attrs.skip)) {
      if (!ids.has(id)) ctx.warnings.push({ path: `${path}.skip`, message: `"${id}" is not an id in ${of}` });
    }
    const fields = fieldsOf(items);
    // title="title" renders the word itself on every item: a field is read only as "{title}".
    for (const [attr, a] of Object.entries(def.attrs)) {
      const v = el.attrs[attr];
      if (!a.item || typeof v !== "string" || hasTemplate(v) || !fields.has(v)) continue;
      ctx.problems.push({ path: `${path}.${attr}`, message: `${show(v)} prints the word itself on every item — to show the ${v} field write ${attr}="{${v}}"` });
    }
    if (name === "Table") {
      for (const col of parseCols(el.attrs.cols)) {
        if (!fields.has(col.key)) ctx.warnings.push({ path: `${path}.cols`, message: `"${col.key}" is not a field of any ${of} item — the column stays empty` });
      }
    }
    if (name === "Chart") {
      const keys = [...splitIds(el.attrs.x), ...splitIds(el.attrs.y)];
      for (const key of keys) if (!fields.has(key)) ctx.warnings.push({ path, message: `"${key}" is not a field of any ${of} item` });
    }
    if (name === "Meter" && typeof el.attrs.value === "string" && !hasTemplate(el.attrs.value) && !NUM_RE.test(el.attrs.value) && !fields.has(el.attrs.value)) {
      ctx.warnings.push({ path: `${path}.value`, message: `"${el.attrs.value}" is not a field of any ${of} item` });
    }
    if (typeof el.attrs.sort === "string") {
      const field = el.attrs.sort.replace(/^-\s*/, "").split(".")[0];
      if (field && !fields.has(field)) ctx.warnings.push({ path: `${path}.sort`, message: `"${field}" is not a field of any ${of} item` });
    }
    if (name === "Map") {
      const missing = items.filter((it) => !Array.isArray(it.geo) && typeof it.address !== "string").length;
      if (missing) ctx.warnings.push({ path, message: `${missing} of ${items.length} ${of} have no geo or address — they get no pin` });
    }
    if (name === "Carousel") checkCarousel(ctx, path, staticCount(items, el, ids));
    if (name === "Filters") checkChips(ctx, el, path);
  } else if (name === "Carousel" && elementChildren.length && of === undefined) {
    checkCarousel(ctx, path, elementChildren.length);
  }
  if (name === "Filters" && !items) checkChips(ctx, el, path);

  // Action references.
  for (const [attr, a] of Object.entries(attrs)) {
    const v = el.attrs[attr];
    if (v === undefined) continue;
    if (a.kind === "actions") {
      for (const id of splitIds(v)) {
        if (!ctx.actions.ids.has(id)) ctx.problems.push({ path: `${path}.${attr}`, message: `action "${id}" is not defined — ${actionList(ctx)}` });
      }
    } else if (a.kind === "action" && typeof v === "string") {
      if (!ctx.actions.ids.has(v)) ctx.problems.push({ path: `${path}.${attr}`, message: `action "${v}" is not defined — ${actionList(ctx)}` });
      else if (name === "Form" && ctx.actions.kinds.get(v) && ctx.actions.kinds.get(v) !== "send") {
        ctx.problems.push({ path: `${path}.${attr}`, message: `"${v}" is kind "${ctx.actions.kinds.get(v)}" — a Form submits a send action` });
      }
    } else if (a.kind === "state" && typeof v === "string") {
      ctx.binds.add(v);
    } else if (a.kind === "expr" && typeof v === "string") {
      ctx.exprChecks.push({ path: `${path}.${attr}`, expr: v, inItem });
    }
  }

  // Specific shapes.
  if (name === "Map") {
    ctx.maps++;
    if (ctx.maps === GENUI_LIMITS.maps + 1) ctx.problems.push({ path, message: `is map ${ctx.maps}, max ${GENUI_LIMITS.maps} per view — use one Map (filters and tabs can switch what it shows)` });
  }
  // A warning, not a problem: views citing past the end rendered before this check.
  if (attrs.source && el.attrs.source !== undefined && !hasTemplate(el.attrs.source)) {
    const r = cachedBase(attrs.source).safeParse(el.attrs.source);
    const n = r.success ? (r.data as number) : 0;
    if (n > ctx.data.sourcesCount) {
      ctx.warnings.push({
        path: `${path}.source`,
        message: ctx.data.sourcesCount
          ? `${n} but data.sources has ${ctx.data.sourcesCount} — source is 1-based (1 = data.sources[0])`
          : `${n} but data has no sources — add data.sources [{title, url, at}]`,
      });
    }
  }
  if (name === "Image" && typeof el.attrs.src === "string" && !hasTemplate(el.attrs.src)) ctx.images.add(el.attrs.src);
  const galleryImages = name === "Gallery" ? dataRef(el.attrs.images, ctx.data.raw) : undefined;
  if (Array.isArray(galleryImages)) {
    galleryImages.forEach((u, i) => {
      if (typeof u !== "string" || !/^https?:\/\/\S+$/i.test(u)) ctx.problems.push({ path: `${path}.images[${i}]`, message: `${show(u)} must be an http(s) URL` });
      else ctx.images.add(u);
    });
  }
  if (name === "Tabs") {
    const labels = splitLabels(el.attrs.labels);
    const n = elementChildren.length;
    if (n < GENUI_LIMITS.tabsMin || n > GENUI_LIMITS.tabsMax) {
      ctx.warnings.push({ path, message: `has ${n} tab${n === 1 ? "" : "s"} — use ${GENUI_LIMITS.tabsMin}–${GENUI_LIMITS.tabsMax} child elements` });
    }
    elementChildren.forEach((c, i) => {
      if (labels[i] === undefined && typeof c.attrs.label !== "string") {
        ctx.warnings.push({ path: uiPath(c), message: `tab ${i + 1} has no label= — it shows as "Tab ${i + 1}"` });
      }
    });
  }
  if (name === "Segmented" || name === "Select" || name === "Choice") {
    const options = parseOptions(el.attrs.options);
    const n = options.length;
    if (el.attrs.options !== undefined && n < 2) ctx.problems.push({ path: `${path}.options`, message: `has ${n} option${n === 1 ? "" : "s"}, needs at least 2` });
    const dflt = el.attrs.default;
    if (typeof dflt === "string" && !hasTemplate(dflt) && n && !options.some((o) => o.value === dflt || o.label === dflt)) {
      ctx.warnings.push({ path: `${path}.default`, message: `"${dflt}" is not one of the options — the first option starts selected` });
    }
  }

  const childInItem = inItem || name === "List";
  for (const c of elementChildren) visitElement(ctx, c, depth + 1, childInItem);
}

function actionList(ctx: UiContext): string {
  const ids = [...ctx.actions.ids];
  return ids.length ? `actions: ${ids.join(", ")}` : "the view defines no actions";
}

// A {…} attribute given as a string names a data key (items="limits").
function checkDataRef(ctx: UiContext, path: string, attr: string, a: AttrDef, key: string): void {
  if (!ctx.data.keys.has(key)) {
    const keys = [...ctx.data.keys];
    ctx.problems.push({ path, message: `"${key}" is not a data key — ${keys.length ? `data keys: ${keys.join(", ")}` : "data has none"}` });
    return;
  }
  const v = ctx.data.raw[key];
  if (v == null || typeof v !== "object") {
    ctx.problems.push({ path, message: `${dataPath("data", [key])} is ${show(v)}, not a list or object${a.doc ? ` (${attr}: ${a.doc})` : ""}` });
  }
}

function checkCarousel(ctx: UiContext, path: string, n: number): void {
  if (n > GENUI_LIMITS.carouselMax) {
    ctx.problems.push({ path, message: `${n} items, max ${GENUI_LIMITS.carouselMax} — paginate or filter (limit=${GENUI_LIMITS.carouselMax}, where=)` });
  } else if (n < GENUI_LIMITS.carouselMin) {
    ctx.problems.push({ path, message: `${n} item${n === 1 ? "" : "s"}, min ${GENUI_LIMITS.carouselMin} — show them in a Grid, List or Card instead` });
  }
}

function checkChips(ctx: UiContext, el: MarkupElement, path: string): void {
  if (el.attrs.chips === undefined) return;
  const chips = parseChips(el.attrs.chips);
  if (!chips.length) {
    ctx.problems.push({ path: `${path}.chips`, message: 'has no chips — "Label: filter, Label: filter"' });
    return;
  }
  chips.forEach((chip, i) => {
    const e = checkWhere(chip.where);
    if (e) ctx.problems.push({ path: `${path}.chips[${i}]`, message: `"${chip.label}": ${e}` });
  });
  for (const on of splitLabels(el.attrs.on)) {
    const idx = /^\d+$/.test(on) ? Number(on) : chips.findIndex((c) => c.label === on);
    if (idx < 0 || idx >= chips.length) ctx.warnings.push({ path: `${path}.on`, message: `"${on}" is not a chip index or label` });
  }
}

function checkExprRefs(ctx: UiContext): void {
  const known = new Set([...ctx.binds, ...ctx.actions.setKeys, ...ctx.data.keys]);
  for (const { path, key } of ctx.actions.stateRefs) {
    if (!ctx.binds.has(key) && !ctx.actions.setKeys.has(key)) {
      ctx.warnings.push({ path, message: `{state.${key}} is never bound (bind="${key}") or set — it prints empty` });
    }
  }
  for (const { path, expr, inItem } of ctx.exprChecks) {
    for (const ref of exprRefs(expr)) {
      const [root, rest] = ref.includes(".") ? (ref.split(".", 2) as [string, string]) : [null, ref];
      if (root === "item") continue;
      if (root === "state" && !ctx.binds.has(rest) && !ctx.actions.setKeys.has(rest)) {
        ctx.warnings.push({ path, message: `state.${rest} is never bound (bind="${rest}") or set — it reads as empty` });
      } else if (root === "data" && !ctx.data.keys.has(rest)) {
        ctx.warnings.push({ path, message: `data.${rest} does not exist — it reads as empty` });
      } else if (root === null && !inItem && !known.has(rest)) {
        ctx.warnings.push({ path, message: `"${rest}" is not a state key (bind=) or data key — it reads as empty` });
      }
    }
  }
}

export function validateView(input: unknown): ViewValidation {
  const problems: ViewProblem[] = [];
  const warnings: ViewProblem[] = [];
  if (!isObj(input)) {
    return { ok: false, problems: [{ path: "input", message: "must be an object with title, ui and summary" }], warnings };
  }
  for (const key of Object.keys(input)) {
    if (!(PRESENT_KEYS as readonly string[]).includes(key)) warnings.push({ path: key, message: `is not a present field — ignored (fields: ${PRESENT_KEYS.join(", ")})` });
  }

  const title = input.title;
  if (typeof title !== "string" || !title.trim()) problems.push({ path: "title", message: "is required — a short heading for the view" });
  else if (title.length > GENUI_LIMITS.titleChars) problems.push({ path: "title", message: `is ${title.length} characters, max ${GENUI_LIMITS.titleChars}` });

  const summary = input.summary;
  if (typeof summary !== "string" || !summary.trim()) {
    problems.push({ path: "summary", message: "is required — the plain-text answer shown when the view can't render" });
  } else if (summary.length > GENUI_LIMITS.summaryChars) {
    problems.push({ path: "summary", message: `is ${summary.length} characters, max ${GENUI_LIMITS.summaryChars}` });
  }

  if (input.tone !== undefined && !(GENUI_TONES as readonly unknown[]).includes(input.tone)) {
    problems.push({ path: "tone", message: `${show(input.tone)} is not one of ${GENUI_TONES.join(", ")}` });
  }
  if (input.icon !== undefined && !(GENUI_ICONS as readonly unknown[]).includes(input.icon)) {
    problems.push({ path: "icon", message: `${show(input.icon)} is not one of ${GENUI_ICONS.join(", ")}` });
  }
  if (input.replaces !== undefined && (typeof input.replaces !== "string" || !VIEW_ID_RE.test(input.replaces))) {
    problems.push({ path: "replaces", message: `${show(input.replaces)} is not a view id (v_ + 12 letters/digits, from an earlier "view … rendered")` });
  }

  const data = validateData(input.data, problems, warnings);
  const actions = validateActions(input.actions, problems, warnings);

  const ctx: UiContext = {
    data,
    actions,
    problems,
    warnings,
    binds: new Set(),
    images: new Set(data.images),
    maps: 0,
    elements: 0,
    depth: 0,
    components: new Set(),
    exprChecks: [],
  };
  let uiBytes = 0;
  const ui = input.ui;
  if (typeof ui !== "string" || !ui.trim()) {
    problems.push({ path: "ui", message: "is required — the markup that lays out the view" });
  } else {
    uiBytes = utf8Bytes(ui);
    if (uiBytes > GENUI_LIMITS.uiBytes) {
      problems.push({ path: "ui", message: `is ${kb(uiBytes)}, max ${kb(GENUI_LIMITS.uiBytes)} — move repeated content into data and reference it` });
    }
    const parsed = parseMarkup(ui);
    for (const e of parsed.errors) problems.push({ path: `ui line ${e.line}`, message: e.message });
    const top = parsed.nodes.filter((n): n is MarkupElement => n.type === "element");
    if (!top.length && !parsed.errors.length) problems.push({ path: "ui", message: "has no components — e.g. <Card of=\"places\" pick=\"…\"/>" });
    for (const node of parsed.nodes as MarkupNode[]) if (node.type === "element") visitElement(ctx, node, 1, false);
    checkExprRefs(ctx);
  }

  if (ctx.images.size > GENUI_LIMITS.images) {
    problems.push({ path: "data", message: `${ctx.images.size} images, max ${GENUI_LIMITS.images} — keep the ones that matter` });
  }

  if (problems.length) return { ok: false, problems, warnings };
  const collections: CollectionStat[] = [...data.collections.entries()].map(([name, items]) => ({ name, count: items.length, type: dominantType(items) }));
  return {
    ok: true,
    warnings,
    stats: {
      uiBytes,
      dataBytes: input.data === undefined ? 0 : utf8Bytes(JSON.stringify(input.data)),
      elements: ctx.elements,
      depth: ctx.depth,
      components: [...ctx.components].sort(),
      collections,
      images: ctx.images.size,
      sites: data.sites.size,
      maps: ctx.maps,
      primaryActions: actions.primary,
    },
  };
}

function dominantType(items: Record<string, unknown>[]): EntityType | null {
  const counts = new Map<string, number>();
  for (const it of items) if (typeof it.type === "string") counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [type, c] of counts) if (c > n) [best, n] = [type, c];
  return best && (ENTITY_TYPES as readonly string[]).includes(best) ? (best as EntityType) : null;
}

// "6 places" — the largest collection, for the tool's success line.
export function statsLine(stats: ViewStats): string {
  const top = [...stats.collections].filter((c) => c.name !== "sources").sort((a, b) => b.count - a.count)[0];
  return top ? `${top.count} ${top.name}` : "";
}
