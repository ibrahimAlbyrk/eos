// The view runtime as plain functions — what useView() hands every kit
// component, built from the spec, the view's state and selection, and a host
// that carries actions out of the view. No React here (ViewContext.jsx wraps
// it), so the behaviour is testable on its own.
//
// State shapes the runtime owns (kits read/write them through getState/setState):
//   Segmented / Select → the option's value · Toggle → boolean
//   Slider / Stepper → number · Field → string
//   Filters → the indices of the chips that are on, under bind= or "_filters_<collection>"
// The runtime seeds those inputs' defaults (default=, else the first option /
// min) so a where="day == state.day" lens works before the user touches them.

import { evalExpr as evalExprRaw, fillTemplate, hasTemplate, matchWhere } from "../../../../../contracts/src/genui/expr.ts";
import { attrBool, attrNum, attrText, parseChips, parseOptions, parseSort, splitIds, splitLabels } from "../../../../../contracts/src/genui/attrs.ts";
import { walkMarkup } from "../../../../../contracts/src/genui/markup.ts";
import { media as defaultMedia } from "./media.js";

export const TONES = {
  blue: "#6ea4e8",
  green: "#6fae86",
  amber: "#c9a163",
  red: "#c47f79",
  violet: "#c8a2ff",
  teal: "#5cb8c4",
};

export const ENTITY_TYPES = ["Place", "Product", "Event", "Person", "Article", "Media", "File", "Generic"];

// Text on a tone fill, and the tone as text on a tinted well (kit/base.css .gv-tone-*).
const TONE_ON = { blue: "#0b1018", green: "#0d1a12", amber: "#1a1408", red: "#1f0f0d", violet: "#170f24", teal: "#08191b" };
const TONE_INK = { blue: "#8ab9f0", green: "#a9d6b6", amber: "#e0c48f", red: "#f0b3ad", violet: "#cbb3f5", teal: "#9fd3e6" };

const VIEW_ID_RE = /^v_[A-Za-z0-9]{12}$/;
// "manager/peer/x.test.ts" — a project-relative file (FileRef path=).
const RELATIVE_PATH_RE = /^[\w.@-][\w.@/-]*\/[\w.@-]+$|^[\w@-][\w.@-]*\.(md|txt|json|jsonl|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|h|cc|cpp|hpp|rb|php|css|scss|html|xml|yml|yaml|toml|ini|sh|zsh|sql|log|csv|lock)$/i;

export function toneOf(tone) {
  return Object.prototype.hasOwnProperty.call(TONES, tone) ? tone : "blue";
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// The CSS custom properties a view root (or a monogram, a badge) sets for a tone.
export function toneVars(tone) {
  const t = toneOf(tone);
  const hex = TONES[t];
  return {
    "--gv-accent": hex,
    "--gv-soft": rgba(hex, 0.14),
    "--gv-glow": rgba(hex, 0.06),
    "--gv-line": rgba(hex, 0.32),
    "--gv-on": TONE_ON[t],
    "--gv-ink": TONE_INK[t],
  };
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// One pass over the markup: which Filters drive which collection, and the
// starting value of every bound scalar input.
export function scanMarkup(nodes) {
  const filters = new Map();
  const defaults = {};
  // collection -> how many elements show it (of=), Filters and Sources aside:
  // a lens whose selection no other lens reflects needn't be selectable.
  const lenses = new Map();
  walkMarkup(nodes ?? [], (el) => {
    const a = el.attrs ?? {};
    const bind = typeof a.bind === "string" && a.bind ? a.bind : null;
    if (typeof a.of === "string" && a.of && el.name !== "Filters" && el.name !== "Sources") {
      lenses.set(a.of, (lenses.get(a.of) ?? 0) + 1);
    }
    switch (el.name) {
      case "Filters": {
        const of = attrText(a.of);
        if (!of || filters.has(of)) break;
        const chips = parseChips(a.chips);
        filters.set(of, { chips, on: initialChips(chips, a.on), key: bind ?? `_filters_${of}` });
        break;
      }
      case "Segmented":
      case "Select": {
        if (!bind || bind in defaults) break;
        const opts = parseOptions(a.options);
        const want = a.default === undefined ? null : attrText(a.default);
        const hit = want != null ? opts.find((o) => o.value === want || o.label === want) : null;
        const v = hit ? hit.value : (want ?? opts[0]?.value);
        if (v !== undefined && v !== null) defaults[bind] = v;
        break;
      }
      case "Toggle":
        if (bind && !(bind in defaults)) defaults[bind] = attrBool(a.default, false);
        break;
      case "Slider":
      case "Stepper": {
        if (!bind || bind in defaults) break;
        const v = attrNum(a.default, attrNum(a.min, el.name === "Stepper" ? 0 : null));
        if (v != null) defaults[bind] = v;
        break;
      }
      case "Field":
        if (bind && !(bind in defaults) && a.default !== undefined) defaults[bind] = attrText(a.default);
        break;
      default:
        break;
    }
  });
  return { filters, defaults, lenses };
}

// on="0" · on="Open now | 2" · on={[0, 2]} — chip indices or labels.
function initialChips(chips, on) {
  if (on === undefined || on === null || on === false) return [];
  const entries = Array.isArray(on) ? on.map(String) : splitLabels(on);
  const out = [];
  for (const raw of entries) {
    const n = attrNum(raw);
    const idx = n != null && Number.isInteger(n) && n >= 0 && n < chips.length ? n : chips.findIndex((c) => c.label === raw);
    if (idx >= 0 && !out.includes(idx)) out.push(idx);
  }
  return out;
}

export function inferEntityKind(item) {
  if (!isObj(item)) return "Generic";
  if (typeof item.type === "string" && ENTITY_TYPES.includes(item.type)) return item.type;
  if (typeof item.path === "string") return "File";
  if (item.geo || item.hours || item.cuisine || item.address) return "Place";
  if (item.start || item.venue) return "Event";
  if (item.role || item.org) return "Person";
  if (item.excerpt || item.author) return "Article";
  if (item.brand || item.inStock !== undefined || item.specs) return "Product";
  if (item.duration || item.kind === "video" || item.kind === "podcast") return "Media";
  return "Generic";
}

const numberFormat = (() => {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  } catch {
    return null;
  }
})();
export const formatNumber = (n) => (numberFormat ? numberFormat.format(n) : String(n));

function sortItems(items, spec) {
  const { field, desc } = spec;
  const keyed = items.map((it, i) => ({ it, i, v: isObj(it) ? it[field] : undefined }));
  keyed.sort((a, b) => {
    const av = a.v;
    const bv = b.v;
    // Missing values sink to the end in both directions.
    if (av == null && bv == null) return a.i - b.i;
    if (av == null) return 1;
    if (bv == null) return -1;
    const an = typeof av === "number" ? av : attrNum(av);
    const bn = typeof bv === "number" ? bv : attrNum(bv);
    const c = an != null && bn != null ? an - bn : String(av).localeCompare(String(bv));
    return (desc ? -c : c) || a.i - b.i;
  });
  return keyed.map((k) => k.it);
}

// What a send action carries back about the item: its id, else the item when small.
export function itemRef(item) {
  if (item == null) return undefined;
  if (typeof item === "string") return item.slice(0, 200);
  if (typeof item === "number") return item;
  if (!isObj(item)) return undefined;
  if (typeof item.id === "string") return item.id.slice(0, 200);
  if (typeof item.id === "number") return item.id;
  try {
    return JSON.stringify(item).length <= 2048 ? item : undefined;
  } catch {
    return undefined;
  }
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The state the agent sees with a send: what the user set, without the kit's
// bookkeeping ("_filters_<col>", "_tabs_…").
function agentState(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

// One send per view at a time, and for a beat after it lands: the POST returns
// in milliseconds, so a lock held only while it is open lets a double click or a
// second press before the reply chip arrives send twice. A failed send releases
// at once so the user can retry.
export const SEND_COOLDOWN_MS = 1500;
const sendLocks = new Map(); // viewId -> locked until (Infinity while the POST is open)
const pendingSubs = new Set();

function emitPending() {
  for (const cb of pendingSubs) cb();
}

export function subscribeSendPending(cb) {
  pendingSubs.add(cb);
  return () => pendingSubs.delete(cb);
}

export function isSendPending(viewId) {
  const until = sendLocks.get(viewId);
  return until != null && until > Date.now();
}

function lockSends(viewId) {
  sendLocks.set(viewId, Infinity);
  emitPending();
}

function releaseSends(viewId, cooldownMs) {
  if (cooldownMs <= 0) {
    sendLocks.delete(viewId);
    emitPending();
    return;
  }
  const until = Date.now() + cooldownMs;
  sendLocks.set(viewId, until);
  emitPending();
  setTimeout(() => {
    if (sendLocks.get(viewId) === until) {
      sendLocks.delete(viewId);
      emitPending();
    }
  }, cooldownMs);
}

// The last send that failed in a view, so the button that sent it can say so
// for a few seconds (Eos has no in-app toasts).
export const SEND_FAILURE_MS = 4000;
const sendFailures = new Map(); // viewId -> { actionId, ref, reason }

export function sendFailure(viewId) {
  return sendFailures.get(viewId) ?? null;
}

function recordFailure(viewId, failure) {
  sendFailures.set(viewId, failure);
  emitPending();
  setTimeout(() => {
    if (sendFailures.get(viewId) === failure) {
      sendFailures.delete(viewId);
      emitPending();
    }
  }, SEND_FAILURE_MS);
}

function clearFailure(viewId) {
  if (sendFailures.delete(viewId)) emitPending();
}

// Test-only.
export function _resetSendLocks() {
  sendLocks.clear();
  sendFailures.clear();
}

// The daemon's idempotency key for an action send: the same view, action and
// item within a few seconds is one message, even if two presses got through.
const CLIENT_ID_BUCKET_MS = 5000;

function hash36(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function actionClientMsgId(viewId, actionId, item, now = Date.now()) {
  let itemKey = "";
  try {
    itemKey = item === undefined ? "" : JSON.stringify(item);
  } catch {
    itemKey = String(item);
  }
  return `gv:${viewId}:${hash36(`${actionId}\u0000${itemKey}`)}:${Math.floor(now / CLIENT_ID_BUCKET_MS).toString(36)}`;
}

// What the reply chip names the item by, when the label doesn't already.
function itemName(item) {
  if (typeof item === "string") return item;
  if (!isObj(item)) return "";
  for (const k of ["name", "title"]) if (typeof item[k] === "string" && item[k].trim()) return item[k].trim();
  return "";
}

// maps:40.98,29.02 · maps:Moda Kıyı → an Apple Maps link the browser can open.
export function mapsHref(href) {
  const rest = href.slice("maps:".length).trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(rest);
  if (m) return `https://maps.apple.com/?daddr=${m[1]},${m[2]}`;
  return `https://maps.apple.com/?q=${encodeURIComponent(rest)}`;
}

const NOOP_HOST = {
  send: async () => ({ ok: false, status: 0 }),
  prefill: () => {},
  openUrl: () => {},
  openFile: () => {},
  openExternal: () => {},
  copy: async () => {},
};

// The runtime for one view. `state` is the stored state (no defaults);
// `selection` the shared selection; setState/select write through the store.
export function createViewRuntime({
  viewId,
  viewTitle = "",
  spec,
  scan = { filters: new Map(), defaults: {}, lenses: new Map() },
  state = {},
  selection = {},
  setState = () => {},
  select = () => {},
  host = NOOP_HOST,
  streaming = false,
  media = defaultMedia,
  // The stored state as it is now. A handler that sets state and then runs an
  // action in the same click (Choice) would otherwise send the state this
  // runtime was built with, before React re-rendered.
  liveState = null,
}) {
  const data = isObj(spec?.data) ? spec.data : {};
  const actions = isObj(spec?.actions) ? spec.actions : {};
  const tone = toneOf(spec?.tone);
  const effState = { ...scan.defaults, ...(isObj(state) ? state : {}) };
  const scopeOf = (item) => ({ item, state: effState, data });
  const cache = new Map();

  const allItems = (name) => (typeof name === "string" && Array.isArray(data[name]) ? data[name] : []);

  const activeChipIdx = (name) => {
    const f = scan.filters.get(name);
    if (!f) return [];
    const v = effState[f.key];
    return Array.isArray(v) ? v.filter((i) => Number.isInteger(i) && i >= 0 && i < f.chips.length) : f.on;
  };

  const filters = (name) => {
    const f = scan.filters.get(name);
    if (!f) return [];
    const on = new Set(activeChipIdx(name));
    return f.chips.map((c, index) => ({ index, label: c.label, where: c.where, on: on.has(index) }));
  };

  const toggleFilter = (name, chipIndex) => {
    const f = scan.filters.get(name);
    if (!f || !Number.isInteger(chipIndex) || chipIndex < 0 || chipIndex >= f.chips.length) return;
    const cur = activeChipIdx(name);
    const next = cur.includes(chipIndex) ? cur.filter((i) => i !== chipIndex) : [...cur, chipIndex].sort((a, b) => a - b);
    setState(f.key, next);
  };

  const clearFilters = (name) => {
    const f = scan.filters.get(name);
    if (f) setState(f.key, []);
  };

  // The collection as every lens sees it (Filters chips applied), then this
  // element's own lens: where=, skip=, sort=, limit=.
  const collection = (name, lens) => {
    const where = lens?.where != null ? attrText(lens.where) : "";
    const skip = lens?.skip != null ? splitIds(lens.skip) : [];
    const sort = lens?.sort != null ? parseSort(lens.sort) : null;
    const limit = lens?.limit != null ? attrNum(lens.limit) : null;
    const key = `${name}\u0000${where}\u0000${skip.join(",")}\u0000${sort ? `${sort.desc ? "-" : ""}${sort.field}` : ""}\u0000${limit ?? ""}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const chips = filters(name).filter((c) => c.on);
    let items = allItems(name);
    if (chips.length) items = items.filter((it) => chips.every((c) => matchWhere(it, c.where, effState)));
    if (where) items = items.filter((it) => matchWhere(it, where, effState));
    if (skip.length) {
      const drop = new Set(skip);
      items = items.filter((it) => !(isObj(it) && it.id != null && drop.has(String(it.id))));
    }
    if (sort?.field) items = sortItems(items, sort);
    if (limit != null && limit >= 0) items = items.slice(0, Math.floor(limit));
    cache.set(key, items);
    return items;
  };

  // A link, a map, a mail/tel link or a file: where each goes. false = not
  // something this view can open (a markdown link keeps its default).
  const open = (href, opts = {}) => {
    const h = typeof href === "string" ? href.trim() : "";
    if (!h || host === NOOP_HOST) return false;
    if (/^https?:\/\//i.test(h)) host.openUrl(h);
    else if (/^maps:/i.test(h)) host.openUrl(mapsHref(h));
    else if (/^(mailto|tel):/i.test(h)) host.openExternal(h);
    else if (/^file:\/\//i.test(h)) host.openFile(decodeURIComponent(h.slice("file://".length)), opts.line);
    else if (h.startsWith("/") || h.startsWith("~/") || RELATIVE_PATH_RE.test(h)) host.openFile(h, opts.line);
    else return false;
    return true;
  };

  const template = (str, item) => fillTemplate(str, scopeOf(item), { formatNumber });
  const evalExpr = (expr, item) => evalExprRaw(typeof expr === "string" ? expr : attrText(expr), scopeOf(item));
  const stateNow = (overrides) => {
    const stored = typeof liveState === "function" ? liveState() : state;
    return { ...scan.defaults, ...(isObj(stored) ? stored : {}), ...(isObj(overrides) ? overrides : {}) };
  };

  const runAction = async (actionId, { item, state: overrides } = {}) => {
    const a = actions[actionId];
    if (!isObj(a)) return { ok: false, reason: `no action "${actionId}"` };
    const st = stateNow(overrides);
    const fill = (v, it) => (typeof v === "string" ? fillTemplate(v, { item: it, state: st, data }, { formatNumber }) : v);
    switch (a.kind) {
      case "send": {
        if (!VIEW_ID_RE.test(viewId ?? "")) return { ok: false, reason: "the view is still being written" };
        if (isSendPending(viewId)) return { ok: false, reason: "busy" };
        const shown = String(fill(a.label, item) || actionId);
        const text = String(fill(a.text ?? a.label, item) || shown);
        const name = itemName(item);
        // The chip reads like the board's round trip: "Masa ayırt · Moda Kıyı".
        const label = name && !shown.includes(name) ? `${shown} · ${name}` : shown;
        const sentState = agentState(st);
        const ref = itemRef(item);
        const action = {
          viewId,
          actionId,
          label: clip(label, 200),
          ...(viewTitle ? { viewTitle: clip(viewTitle, 200) } : {}),
          ...(ref !== undefined ? { item: ref } : {}),
          ...(Object.keys(sentState).length ? { state: sentState } : {}),
        };
        lockSends(viewId);
        let result;
        try {
          const r = await host.send(text, { action, queueWhenBusy: true, clientMsgId: actionClientMsgId(viewId, actionId, ref) });
          result = r?.ok !== false ? { ok: true } : { ok: false, reason: r.body?.error ?? `send failed (${r.status})` };
        } catch (e) {
          result = { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
        releaseSends(viewId, result.ok ? SEND_COOLDOWN_MS : 0);
        if (result.ok) clearFailure(viewId);
        else recordFailure(viewId, { actionId, ref, reason: result.reason });
        return result;
      }
      case "prefill": {
        const text = fill(a.text, item);
        if (text) host.prefill(String(text));
        return { ok: Boolean(text) };
      }
      case "copy": {
        const text = fill(a.text, item);
        if (!text) return { ok: false };
        await host.copy(String(text));
        return { ok: true };
      }
      case "open": {
        const href = String(fill(a.href, item) ?? "").trim();
        if (!href) return { ok: false, reason: "nothing to open" };
        return open(href) ? { ok: true } : { ok: false, reason: `can't open ${href}` };
      }
      case "set": {
        if (!isObj(a.set)) return { ok: false };
        for (const [k, v] of Object.entries(a.set)) setState(k, typeof v === "string" && hasTemplate(v) ? fill(v, item) : v);
        return { ok: true };
      }
      default:
        return { ok: false, reason: `unknown action kind "${a.kind}"` };
    }
  };

  return {
    viewId,
    viewTitle,
    tone,
    data,
    actions,
    streaming,
    state: effState,
    collection,
    allItems,
    lensCount: (name) => scan.lenses?.get(name) ?? 0,
    selected: (name) => (isObj(selection) ? selection[name] ?? null : null),
    select: (name, id) => select(name, id ?? null),
    filters,
    toggleFilter,
    clearFilters,
    getState: (key, fallback) => (effState[key] !== undefined ? effState[key] : fallback),
    setState,
    runAction,
    open,
    actionPending: () => isSendPending(viewId),
    media,
    template,
    evalExpr,
    entityKind: inferEntityKind,
    formatNumber,
    item: undefined,
  };
}

// The runtime as one item's template scope sees it (inside a List row, a card).
export function bindItem(rt, item) {
  if (item === undefined) return rt;
  return {
    ...rt,
    item,
    template: (str, it = item) => rt.template(str, it),
    evalExpr: (expr, it = item) => rt.evalExpr(expr, it),
    runAction: (id, opts = {}) => rt.runAction(id, { item, ...opts }),
  };
}
