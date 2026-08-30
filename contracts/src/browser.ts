// Browser subsystem — every shape the daemon, the panel and the `browser_*`
// agent tools share. The human sees a real embedded WebContentsView in the app
// (driven over /browser/host); a headless Chrome-over-CDP adapter is the
// fallback. A tabId is Eos-minted and never leaks the CDP targetId, so this file
// is the entire JSON surface a client (UI or agent) ever sees — there is no
// pixel/frame path here.

import { z } from "zod";

// ---- Session scoping -------------------------------------------------------
// sessionKey is the id of a session's ROOT worker row (the parent_id-chain
// root, usually an orchestrator o-…), or GLOBAL_SESSION for the no-session
// context (empty pane / wave-1 compat / perSession=false). Whether a session
// maps to a Chrome process or a CDP context is daemon-internal — this file
// only ever sees the opaque key.
export const GLOBAL_SESSION = "global";

// ---- Tab identity ----------------------------------------------------------
// tabId is Eos-minted and stable for the tab's life; the daemon maps it to the
// CDP targetId (also stable per tab, but daemon-internal).
// audible/muted are live audio state — the browser plays through the system
// output device, so the panel renders and drives a per-tab mute from these.

export const BrowserTabSchema = z.object({
  tabId: z.string(),
  sessionId: z.string(),                                  // owning session's key (GLOBAL_SESSION when unscoped)
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  audible: z.boolean(),                                    // the tab is currently making sound
  muted: z.boolean(),
  faviconDataUri: z.string().nullable().optional(),
});
export type BrowserTab = z.infer<typeof BrowserTabSchema>;

// ---- Engine status (SSE browser:status + GET /browser/status) --------------

export const BrowserEngineStateSchema = z.enum([
  "absent",     // no Chrome binary found
  "launching",
  "running",
  "crashed",
  "disabled",   // config.browser.enabled === false
]);
export type BrowserEngineState = z.infer<typeof BrowserEngineStateSchema>;

export const BrowserStatusSchema = z.object({
  state: BrowserEngineStateSchema,
  chromePath: z.string().nullable(),
  tabCount: z.number(),
  // Present when the panel fetched per-session engine state via ?session=.
  // Optional for wave-1 compat; engine lifecycle itself is process-global.
  sessionId: z.string().optional(),
});
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;

// ---- Device emulation ------------------------------------------------------
// responsive: panel CSS width, host dsf, mobile:false, no touch.
// mobile:     375x812  dsf3 mobile:true  touch, iPhone UA.
// tablet:     768x1024 dsf2 mobile:true  touch, iPad UA.

export const BrowserDeviceSchema = z.enum(["responsive", "mobile", "tablet"]);
export type BrowserDevice = z.infer<typeof BrowserDeviceSchema>;

export const BrowserDeviceRequestSchema = z.object({ device: BrowserDeviceSchema });
export type BrowserDeviceRequest = z.infer<typeof BrowserDeviceRequestSchema>;

// ---- Element payload (picker + snapshot). NEVER outerHTML. -----------------
// The minimal payload: ~40-80 tokens typical, so an attached element costs a
// chip, not a page dump.

export const BrowserElementSchema = z.object({
  ref: z.string(),                                          // opaque, snapshot-minted (backendNodeId-backed)
  tag: z.string(),
  role: z.string(),
  name: z.string(),                                         // accname, truncate ~100 ch
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]), // x,y,w,h viewport CSS px
  focusable: z.boolean(),
  state: z.array(z.string()).optional(),                    // non-default only: checked/disabled/expanded/pressed/selected/invalid
  value: z.string().optional(),                             // REDACT password inputs
  locator: z.string(),                                      // durable role=..[name=..] selector
});
export type BrowserElement = z.infer<typeof BrowserElementSchema>;

// Picker probe: `hover` highlights + describes without acting, `at` resolves a
// clicked point. Coordinates are viewport CSS px (canvas→page translated
// client-side).
export const BrowserElementQuerySchema = z.object({
  hover: z.tuple([z.number(), z.number()]).optional(),
  at: z.tuple([z.number(), z.number()]).optional(),
});
export type BrowserElementQuery = z.infer<typeof BrowserElementQuerySchema>;

// ---- Agent tool I/O --------------------------------------------------------
// Every tool takes optional tabId (default = active tab). Handlers return a
// STRING or JSON object; the MCP channel is text-only (safeText), so the
// screenshot/capture verbs return a { path } — never bytes.

export const BrowserNavigateRequestSchema = z.object({
  tabId: z.string().optional(),
  action: z.enum(["url", "back", "forward", "reload"]),
  url: z.string().optional(),                               // required iff action==="url"
});
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequestSchema>;

export const BrowserSnapshotRequestSchema = z.object({
  tabId: z.string().optional(),
  interactiveOnly: z.boolean().default(true),               // shrink the tree
  selector: z.string().optional(),                          // scope to a CSS subtree
  depth: z.number().int().positive().optional(),
});
export type BrowserSnapshotRequest = z.infer<typeof BrowserSnapshotRequestSchema>;

export const BrowserSnapshotResponseSchema = z.object({
  tabId: z.string(),
  url: z.string(),
  snapshot: z.string(),                                     // indented ref-annotated a11y text; refs are @eN
});
export type BrowserSnapshotResponse = z.infer<typeof BrowserSnapshotResponseSchema>;

export const BrowserFindRequestSchema = z.object({
  tabId: z.string().optional(),
  query: z.string(),                                        // text or /regex/ — cheap locate, no full tree
});
export type BrowserFindRequest = z.infer<typeof BrowserFindRequestSchema>;

export const BrowserActRequestSchema = z.object({
  tabId: z.string().optional(),
  ref: z.string(),
  verb: z.enum(["click", "hover", "focus", "check", "uncheck"]),
  includeSnapshot: z.boolean().default(false),              // DEFAULT FALSE — an auto-attached snapshot is the token blowup
});
export type BrowserActRequest = z.infer<typeof BrowserActRequestSchema>;

export const BrowserTypeRequestSchema = z.object({
  tabId: z.string().optional(),
  ref: z.string(),
  text: z.string(),
  submit: z.boolean().default(false),                       // press Enter after
  includeSnapshot: z.boolean().default(false),
});
export type BrowserTypeRequest = z.infer<typeof BrowserTypeRequestSchema>;

export const BrowserFillFormRequestSchema = z.object({
  tabId: z.string().optional(),
  fields: z.array(z.object({ ref: z.string(), value: z.string() })),
});
export type BrowserFillFormRequest = z.infer<typeof BrowserFillFormRequestSchema>;

export const BrowserPressRequestSchema = z.object({
  tabId: z.string().optional(),
  key: z.string(),                                          // "Enter", "Tab", "Control+a"
});
export type BrowserPressRequest = z.infer<typeof BrowserPressRequestSchema>;

export const BrowserScrollRequestSchema = z.object({
  tabId: z.string().optional(),
  direction: z.enum(["up", "down", "top", "bottom"]),
  ref: z.string().optional(),                               // scroll a container
});
export type BrowserScrollRequest = z.infer<typeof BrowserScrollRequestSchema>;

export const BrowserWaitRequestSchema = z.object({
  tabId: z.string().optional(),
  forText: z.string().optional(),
  forRef: z.string().optional(),
  forMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(15000),
});
export type BrowserWaitRequest = z.infer<typeof BrowserWaitRequestSchema>;

export const BrowserGetRequestSchema = z.object({
  tabId: z.string().optional(),
  what: z.enum(["text", "url", "title", "value"]),
  ref: z.string().optional(),                               // required for text/value on an element
});
export type BrowserGetRequest = z.infer<typeof BrowserGetRequestSchema>;

export const BrowserScreenshotRequestSchema = z.object({
  tabId: z.string().optional(),
  fullPage: z.boolean().default(false),                     // clamp clip.height*dsf ≤ 8192, tile beyond
});
export type BrowserScreenshotRequest = z.infer<typeof BrowserScreenshotRequestSchema>;

export const BrowserScreenshotResponseSchema = z.object({
  path: z.string(),                                         // temp file, agent reads it (text-only channel)
});
export type BrowserScreenshotResponse = z.infer<typeof BrowserScreenshotResponseSchema>;

export const BrowserEvalRequestSchema = z.object({
  tabId: z.string().optional(),
  expression: z.string(),                                   // IN-PAGE eval only; gated as browserWrite
});
export type BrowserEvalRequest = z.infer<typeof BrowserEvalRequestSchema>;

export const BrowserTabsResponseSchema = z.object({
  tabs: z.array(BrowserTabSchema),
  sessionId: z.string().optional(),                       // present when the list is session-scoped
});
export type BrowserTabsResponse = z.infer<typeof BrowserTabsResponseSchema>;

export const BrowserNewTabRequestSchema = z.object({ url: z.string().optional() });
export type BrowserNewTabRequest = z.infer<typeof BrowserNewTabRequestSchema>;

// Audio is live: sound leaves through the system output device, so mute is an
// explicit control rather than a launch flag. Omitted tabId = the active tab.
export const BrowserMuteRequestSchema = z.object({
  tabId: z.string().optional(),
  muted: z.boolean(),
});
export type BrowserMuteRequest = z.infer<typeof BrowserMuteRequestSchema>;

// ---- Response shapes for find / wait / get --------------------------------
// find: the cheap locate path — up to a server-side cap (~10) of matching
// elements, each the minimal BrowserElement payload, never markup.
export const BrowserFindResponseSchema = z.object({
  tabId: z.string(),
  url: z.string(),
  matches: z.array(BrowserElementSchema),
});
export type BrowserFindResponse = z.infer<typeof BrowserFindResponseSchema>;

export const BrowserWaitResponseSchema = z.object({
  ok: z.boolean(),
  timedOut: z.boolean(),
  elapsedMs: z.number(),
});
export type BrowserWaitResponse = z.infer<typeof BrowserWaitResponseSchema>;

export const BrowserGetResponseSchema = z.object({
  tabId: z.string(),
  what: z.enum(["text", "url", "title", "value"]),
  value: z.string(),
});
export type BrowserGetResponse = z.infer<typeof BrowserGetResponseSchema>;

// ---- Present (browser_show) ------------------------------------------------
// The agent's "look here now" verb: surfaces the panel showing tabId (default:
// the caller session's active tab). Mutates no page state.
export const BrowserShowRequestSchema = z.object({
  tabId: z.string().optional(),                           // omit = the caller session's active tab
});
export type BrowserShowRequest = z.infer<typeof BrowserShowRequestSchema>;

export const BrowserShowResponseSchema = z.object({
  ok: z.literal(true),
  tabId: z.string(),                                       // the tab actually presented
});
export type BrowserShowResponse = z.infer<typeof BrowserShowResponseSchema>;

// ---- SSE browser:activity payload ------------------------------------------
// Fire-and-forget "an agent acted" signal: "use" = a tab opened / navigated;
// "present" = an explicit browser_show. Drives the panel's auto-open / badge /
// bring-to-front rules.
export const BrowserActivityKindSchema = z.enum(["use", "present"]);
export type BrowserActivityKind = z.infer<typeof BrowserActivityKindSchema>;

export const BrowserActivitySchema = z.object({
  sessionId: z.string(),                                   // sessionKey the activity belongs to
  workerId: z.string(),                                    // the agent that acted (x-eos-agent-id)
  kind: BrowserActivityKindSchema,
  tabId: z.string(),
  url: z.string().optional(),
});
export type BrowserActivity = z.infer<typeof BrowserActivitySchema>;
