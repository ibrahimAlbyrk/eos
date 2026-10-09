// Wire shapes of visual answers: the two tool inputs, the stored view, its UI
// state, the action a click sends back, the streaming delta, and the request /
// response bodies of every /api/genui route. Plan: docs/genui/00-GENUI-PLAN.md.

import { z } from "zod";
import {
  ActionSchema,
  GENUI_LIMITS,
  IconSchema,
  PlaceSchema,
  ToneSchema,
  VIEW_ID_RE,
  formatProblems,
  statsLine,
  utf8Bytes,
  type ViewProblem,
  type ViewStats,
} from "./catalog.ts";

export const ViewIdSchema = z.string().regex(VIEW_ID_RE, "must be a view id (v_ + 12 letters/digits)");
export type ViewId = z.infer<typeof ViewIdSchema>;

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// A fresh view id. `random` fills a byte array (default: Web Crypto).
export function newViewId(random: (bytes: Uint8Array) => Uint8Array = (b) => globalThis.crypto.getRandomValues(b)): string {
  const out: string[] = [];
  while (out.length < 12) {
    for (const byte of random(new Uint8Array(16))) {
      // 248 = 62 * 4: reject the tail so every character is equally likely.
      if (byte < 248 && out.length < 12) out.push(BASE62[byte % 62]);
    }
  }
  return `v_${out.join("")}`;
}

// ---- tool inputs ----------------------------------------------------------------

// `present` — the shape only; validateView (catalog.ts) does the full check and
// phrases the problems. Key order matters for streaming: the model writes them
// in this order.
export const PresentInputSchema = z.object({
  title: z.string().min(1).max(GENUI_LIMITS.titleChars),
  tone: ToneSchema.optional(),
  icon: IconSchema.optional(),
  replaces: ViewIdSchema.optional(),
  data: z.record(z.unknown()).optional(),
  actions: z.record(ActionSchema).optional(),
  ui: z.string().min(1).max(GENUI_LIMITS.uiBytes),
  summary: z.string().min(1).max(GENUI_LIMITS.summaryChars),
});
export type PresentInput = z.infer<typeof PresentInputSchema>;

export const PresentAppInputSchema = z.object({
  title: z.string().min(1).max(GENUI_LIMITS.titleChars),
  html: z.string().min(1).max(GENUI_LIMITS.appHtmlBytes),
  summary: z.string().min(1).max(GENUI_LIMITS.summaryChars),
  height: z.number().int().min(GENUI_LIMITS.appHeightMin).max(GENUI_LIMITS.appHeightMax).optional(),
});
export type PresentAppInput = z.infer<typeof PresentAppInputSchema>;

// MCP input shapes for the two tools: deliberately loose (strings, records), so a
// slip reaches validateView/validateApp and comes back as a precise problem
// instead of a schema rejection from the SDK.
export const PRESENT_TOOL_SHAPE = {
  title: z.string().describe("≤ 80 chars"),
  tone: z.string().optional().describe("blue | green | amber | red | violet | teal"),
  icon: z.string().optional(),
  replaces: z.string().optional().describe("id of an earlier view this one updates"),
  data: z.record(z.unknown()).optional().describe("collections (arrays of entities) and scalars, written once"),
  actions: z.record(z.unknown()).optional(),
  ui: z.string().describe("markup that references data"),
  summary: z.string().describe("plain-text fallback, ≤ 600 chars"),
};

export const PRESENT_APP_TOOL_SHAPE = {
  title: z.string().describe("≤ 80 chars"),
  html: z.string().describe("one self-contained HTML document, ≤ 256 KB"),
  summary: z.string().describe("plain-text fallback, ≤ 600 chars"),
  height: z.number().optional().describe("initial height in px, 200–720"),
};

export type AppValidation =
  | { ok: true; warnings: ViewProblem[]; stats: { htmlBytes: number } }
  | { ok: false; problems: ViewProblem[]; warnings: ViewProblem[] };

// present_app's full check: one HTML document within the limits.
export function validateApp(input: unknown): AppValidation {
  const problems: ViewProblem[] = [];
  const warnings: ViewProblem[] = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, problems: [{ path: "input", message: "must be an object with title, html and summary" }], warnings };
  }
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["title", "html", "summary", "height"].includes(key)) warnings.push({ path: key, message: "is not a present_app field — ignored" });
  }
  if (typeof o.title !== "string" || !o.title.trim()) problems.push({ path: "title", message: "is required — a short name for the app" });
  else if (o.title.length > GENUI_LIMITS.titleChars) problems.push({ path: "title", message: `is ${o.title.length} characters, max ${GENUI_LIMITS.titleChars}` });
  if (typeof o.summary !== "string" || !o.summary.trim()) {
    problems.push({ path: "summary", message: "is required — what the app does, in plain text" });
  } else if (o.summary.length > GENUI_LIMITS.summaryChars) {
    problems.push({ path: "summary", message: `is ${o.summary.length} characters, max ${GENUI_LIMITS.summaryChars}` });
  }
  if (o.height !== undefined) {
    const h = o.height;
    if (typeof h !== "number" || !Number.isInteger(h) || h < GENUI_LIMITS.appHeightMin || h > GENUI_LIMITS.appHeightMax) {
      problems.push({ path: "height", message: `${JSON.stringify(h)} is outside ${GENUI_LIMITS.appHeightMin}–${GENUI_LIMITS.appHeightMax}` });
    }
  }
  let htmlBytes = 0;
  if (typeof o.html !== "string" || !o.html.trim()) {
    problems.push({ path: "html", message: "is required — one self-contained HTML document" });
  } else {
    htmlBytes = utf8Bytes(o.html);
    if (htmlBytes > GENUI_LIMITS.appHtmlBytes) {
      problems.push({ path: "html", message: `is ${Math.round(htmlBytes / 1024)} KB, max ${GENUI_LIMITS.appHtmlBytes / 1024} KB — inline less` });
    }
    const docs = (o.html.match(/<html[\s>]/gi) ?? []).length;
    if (docs > 1) problems.push({ path: "html", message: `holds ${docs} <html> documents — send one` });
    if (!/<[a-z!][^>]*>/i.test(o.html)) problems.push({ path: "html", message: "has no HTML tags — send an HTML document" });
    if (/<script[^>]+\bsrc\s*=/i.test(o.html) || /<link[^>]+\bhref\s*=\s*["']?https?:/i.test(o.html)) {
      warnings.push({ path: "html", message: "loads external files — the sandbox blocks the network, inline them" });
    }
  }
  if (problems.length) return { ok: false, problems, warnings };
  return { ok: true, warnings, stats: { htmlBytes } };
}

// ---- stored views --------------------------------------------------------------

export const ViewKindSchema = z.enum(["view", "app"]);
export type ViewKind = z.infer<typeof ViewKindSchema>;

const viewRecordBase = {
  id: ViewIdSchema,
  workerId: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
};

export const ViewRecordSchema = z.discriminatedUnion("kind", [
  z.object({ ...viewRecordBase, kind: z.literal("view"), spec: PresentInputSchema }),
  z.object({ ...viewRecordBase, kind: z.literal("app"), spec: PresentAppInputSchema }),
]);
export type ViewRecord = z.infer<typeof ViewRecordSchema>;

// Per-instance UI state (filters, ticks, the current step): plain JSON, ≤ 32 KB.
export const ViewStateSchema = z
  .record(z.unknown())
  .refine((s) => {
    try {
      return utf8Bytes(JSON.stringify(s)) <= GENUI_LIMITS.stateBytes;
    } catch {
      return false;
    }
  }, `view state is larger than ${GENUI_LIMITS.stateBytes / 1024} KB`);
export type ViewState = z.infer<typeof ViewStateSchema>;

// ---- view actions ---------------------------------------------------------------

// A click on a send action, carried on POST …/message beside `text`.
// item: the item's id, or the item itself; state: the view's state at the click.
export const ViewActionSchema = z.object({
  viewId: ViewIdSchema,
  actionId: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  viewTitle: z.string().max(200).optional(),
  item: z.union([z.string().max(200), z.number(), z.record(z.unknown())]).optional(),
  state: ViewStateSchema.optional(),
});
export type ViewAction = z.infer<typeof ViewActionSchema>;

// What the stored user_message keeps of it (the chat shows `label` as the reply chip).
export const UserMessageActionSchema = z.object({
  viewId: ViewIdSchema,
  label: z.string(),
  viewTitle: z.string().optional(),
});
export type UserMessageAction = z.infer<typeof UserMessageActionSchema>;

// ---- streaming --------------------------------------------------------------------

// Bus topic "genui:delta" (claude SDK lane): the raw input_json_delta text of a
// present call while the model writes it. start (text "") → append… → stop.
export const GenuiDeltaSchema = z.object({
  workerId: z.string(),
  callId: z.string(),
  // The tool's full name, e.g. "mcp__orchestrator__present".
  name: z.string(),
  phase: z.enum(["start", "append", "stop"]),
  text: z.string(),
});
export type GenuiDelta = z.infer<typeof GenuiDeltaSchema>;

// Bus topic "genui:change": a view's state was replaced.
export const GenuiChangeSchema = z.object({ viewId: ViewIdSchema, state: ViewStateSchema });
export type GenuiChange = z.infer<typeof GenuiChangeSchema>;

export const GENUI_TOPICS = { delta: "genui:delta", change: "genui:change" } as const;

// ---- routes -----------------------------------------------------------------------

export const ViewProblemSchema = z.object({ path: z.string(), message: z.string() });

export const ViewStatsSchema = z.object({
  uiBytes: z.number(),
  dataBytes: z.number(),
  elements: z.number(),
  depth: z.number(),
  components: z.array(z.string()),
  collections: z.array(z.object({ name: z.string(), count: z.number(), type: z.string().nullable() })),
  images: z.number(),
  sites: z.number(),
  maps: z.number(),
  primaryActions: z.number(),
});

// POST /api/genui/views (agent plane: the present tool). `input` is the raw tool
// input — validated by validateView in the daemon.
export const CreateViewRequestSchema = z.object({ input: z.unknown() });
export type CreateViewRequest = z.infer<typeof CreateViewRequestSchema>;

export const CreateViewResponseSchema = z.object({
  viewId: ViewIdSchema,
  warnings: z.array(ViewProblemSchema),
  stats: ViewStatsSchema,
});
export type CreateViewResponse = z.infer<typeof CreateViewResponseSchema>;

// 400 from POST /api/genui/views and /api/genui/apps: `error` is formatProblems()
// (what the tool hands the model), `problems` the same list structured.
export const GenuiRejectionSchema = z.object({ error: z.string(), problems: z.array(ViewProblemSchema) });
export type GenuiRejection = z.infer<typeof GenuiRejectionSchema>;

export function genuiRejection(problems: readonly ViewProblem[]): GenuiRejection {
  return { error: formatProblems(problems), problems: [...problems] };
}

// POST /api/genui/apps (present_app).
export const CreateAppRequestSchema = z.object({ input: z.unknown() });
export type CreateAppRequest = z.infer<typeof CreateAppRequestSchema>;
export const CreateAppResponseSchema = z.object({ viewId: ViewIdSchema, warnings: z.array(ViewProblemSchema) });
export type CreateAppResponse = z.infer<typeof CreateAppResponseSchema>;

// GET /api/genui/views/:id → ViewRecord.
// GET /api/genui/views/:id/state → ViewStateResponse; PUT (ui-token) PutViewStateRequest → ViewStateResponse.
export const ViewStateResponseSchema = z.object({ viewId: ViewIdSchema, state: ViewStateSchema, updatedAt: z.number().nullable() });
export type ViewStateResponse = z.infer<typeof ViewStateResponseSchema>;
export const PutViewStateRequestSchema = z.object({ state: ViewStateSchema });
export type PutViewStateRequest = z.infer<typeof PutViewStateRequestSchema>;

// GET /api/genui/media/img?src= · /og?url= · /icon?site= → image bytes (404 when
// nothing resolves; the kit falls back to a monogram).
export const MediaImgQuerySchema = z.object({ src: z.string().url().max(2048) });
export const MediaOgQuerySchema = z.object({ url: z.string().url().max(2048) });
export const MediaIconQuerySchema = z.object({ site: z.string().min(1).max(253) });

export const LatLonSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
export type LatLon = z.infer<typeof LatLonSchema>;

export const AreaSchema = z.object({
  district: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
});
export type Area = z.infer<typeof AreaSchema>;

// GET /api/genui/geocode?q=&limit=
export const GeocodeQuerySchema = z.object({ q: z.string().min(1).max(300), limit: z.coerce.number().int().min(1).max(10).optional() });
export const GeocodeResultSchema = LatLonSchema.extend({ label: z.string(), area: AreaSchema.optional(), kind: z.string().optional() });
export type GeocodeResult = z.infer<typeof GeocodeResultSchema>;
export const GeocodeResponseSchema = z.object({ results: z.array(GeocodeResultSchema), attribution: z.string() });
export type GeocodeResponse = z.infer<typeof GeocodeResponseSchema>;

// POST /api/genui/places (find_places tool).
export const PlacesRequestSchema = z
  .object({
    query: z.string().min(1).max(200).optional(),
    category: z.string().min(1).max(60).optional(),
    near: z.union([LatLonSchema, z.object({ text: z.string().min(1).max(300) })]),
    radiusM: z.number().int().min(50).max(20_000).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  })
  .refine((b) => Boolean(b.query || b.category), { message: "query or category is required" });
export type PlacesRequest = z.infer<typeof PlacesRequestSchema>;
export const PlacesResponseSchema = z.object({ places: z.array(PlaceSchema), attribution: z.string() });
export type PlacesResponse = z.infer<typeof PlacesResponseSchema>;

// GET /api/location (local-only; 403 unless location sharing is on).
// LocationFix is what the app's location.get RPC returns; the daemon adds `area`.
export const LocationFixSchema = LatLonSchema.extend({ accuracy: z.number().nonnegative(), at: z.number() });
export type LocationFix = z.infer<typeof LocationFixSchema>;
export const LocationResponseSchema = LocationFixSchema.extend({ area: AreaSchema.optional() });
export type LocationResponse = z.infer<typeof LocationResponseSchema>;

// ---- settings ---------------------------------------------------------------------

export const GenuiLevelSchema = z.enum(["rich", "balanced", "text"]);
export type GenuiLevel = z.infer<typeof GenuiLevelSchema>;

// settings.json keys (location.share is writable only through PUT /api/settings/genui).
export const GENUI_SETTING_KEYS = { level: "genui.level", apps: "genui.apps", locationShare: "location.share" } as const;
export const GENUI_SETTING_DEFAULTS = { level: "balanced", apps: true, locationShare: false } as const satisfies {
  level: GenuiLevel;
  apps: boolean;
  locationShare: boolean;
};

// config.json block `genui`. The logo.dev key is publishable (pk_…), so GET returns it.
export const LogoDevKeySchema = z.string().regex(/^pk_[A-Za-z0-9_-]{4,200}$/, "must be a logo.dev publishable key (pk_…)");
export const GenuiConfigSchema = z.object({ logoDevKey: LogoDevKeySchema.optional() });
export type GenuiConfig = z.infer<typeof GenuiConfigSchema>;

// GET /api/settings/genui → GenuiSettings; PUT (ui-token) GenuiSettingsPatch → GenuiSettings.
export const GenuiSettingsSchema = z.object({
  level: GenuiLevelSchema,
  apps: z.boolean(),
  locationShare: z.boolean(),
  logoDevKey: z.string().nullable(),
});
export type GenuiSettings = z.infer<typeof GenuiSettingsSchema>;
export const GenuiSettingsPatchSchema = z.object({
  level: GenuiLevelSchema.optional(),
  apps: z.boolean().optional(),
  locationShare: z.boolean().optional(),
  // null or "" clears the key.
  logoDevKey: z.union([LogoDevKeySchema, z.literal(""), z.null()]).optional(),
});
export type GenuiSettingsPatch = z.infer<typeof GenuiSettingsPatchSchema>;

// The tool text when the user turned visual answers off.
export const GENUI_OFF_TEXT = "Visual answers are off — answer in text";

// ---- tool result text ---------------------------------------------------------------

// "view v_… rendered · 6 places · 2 images unresolved → monograms", then warnings.
export function presentSuccessText(
  viewId: string,
  stats: ViewStats,
  opts: { unresolvedImages?: number; warnings?: readonly ViewProblem[] } = {},
): string {
  const parts = [`view ${viewId} rendered`];
  const line = statsLine(stats);
  if (line) parts.push(line);
  if (opts.unresolvedImages) parts.push(`${opts.unresolvedImages} image${opts.unresolvedImages === 1 ? "" : "s"} unresolved → monograms`);
  const head = parts.join(" · ");
  const warnings = opts.warnings ?? [];
  if (!warnings.length) return head;
  return [head, "warnings (fix next time, no need to re-present):", ...warnings.map((w) => `· ${w.path}: ${w.message}`)].join("\n");
}

export function appSuccessText(viewId: string): string {
  return `view ${viewId} rendered · app`;
}
