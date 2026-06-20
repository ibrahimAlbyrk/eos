# Generic tool fallback rendering — design

Status: design only (no renderer implementation in this change)
Scope: `app/ui/` — how a worker's tool call renders as a card in the chat timeline.

## TL;DR

The chat already renders tools through a registry-with-default (`toolViews.jsx`:
`register()` → `VIEWS` Map → `getToolView()` → `DEFAULT`/`GenericDetail`). The
open/closed pattern the task asks for is therefore *already chosen* — but it is
not the **only** path and its default is **thin**. Two problems:

1. A **second, hardcoded dispatcher** (`WorkerToolCard.jsx` keyed on
   `WORKER_TOOL_SPECS`/`BODIES` literal maps) renders the six worker-management
   MCP tools and has **no fallback** — it is a parallel presentation system for
   the same concept.
2. The generic fallback that *does* exist (`DEFAULT` + `GenericDetail`) shows the
   **raw, namespaced tool id** as its headline (`Used mcp__context7__query-docs`),
   gives unknown tools **no args summary** in the header, dumps params via
   `String(val)`/`JSON.stringify` with `word-break: break-all`, and has **no copy
   / no raw-payload affordance**.

This design = **consolidate to one dispatcher + one strengthened generic
fallback**. Custom renderers stay the open-for-extension special case
(`register(name, …)` — never touch the dispatcher or the fallback).

---

## 1. Current architecture

### 1.1 Event → component data flow

```
hooks (PreToolUse/PostToolUse, settings.ts)
  └─ tool_running / tool_done events  ── contracts/src/events.ts
        ToolRunningPayload { toolName, toolUseId, input, parentAgentToolUseId? }
        ToolDonePayload    { toolName, toolUseId, result, parentAgentToolUseId? }
  └─ jsonl  tool_use / tool_result    (richer: exact text, structuredPatch)
  └─ agent_event (in-process/sdk lanes; normalized back to the two shapes above)
        │
   SSE  ▼  (api/sse.js)
state/eventsStore.js          module-scope window cache, pagination, polling
        │
hooks/useWorkerEvents.js      useSyncExternalStore subscription per worker
        │
views/code/messages/Messages.jsx
   buildBlocks(applyRewinds(applyClears(events)))     ── lib/messageParser.js
        │  normalizeEvents → deriveToolLifecycle → per-tool object + lane grouping
        ▼
   renderBlock(block):
     "toolGroup" → <ToolGroup> → maps each tool → <ToolItem>
     "tool"      → <ToolItem standalone>
        │
   views/code/messages/ToolItem.jsx     ← THE DISPATCH POINT
     if isWorkerToolName(name) → <WorkerToolCard>     (dispatcher #2)
     else                      → <PlainToolItem>      (dispatcher #1)
                                   getToolView(name)  → header + <view.Detail>
```

### 1.2 The per-tool object (the data budget any renderer sees)

`lib/messageParser.js` (`buildBlocks`) emits one normalized object per tool. This
is the *entire* contract a renderer consumes:

```js
{
  id,            // toolUseId
  name,          // "Read" | "Bash" | "mcp__context7__query-docs" | …
  verb,          // coarse class: "read" | "edit" | "bash" (verbFor)
  input,         // UnknownRecord — the tool's raw args
  result,        // { text, isError, patch } | null   (null while running)
  running,       // bool — authoritative, from deriveToolLifecycle.isClosed()
  done,          // bool
  ts,
  // optional, attached for specific tools:
  skillBody, skillPath,   // Skill
  peerTo,                 // ask_peer / respond_to_peer
}
```

`running`/`done`/`result` come from `lib/toolLifecycle.js` (`deriveToolLifecycle`)
— the single source of truth for "is this tool still running?" (jsonl
`tool_result` wins over the `tool_done` hook copy; turn/exit barriers close
orphans). **Renderers must treat `tool.running`/`tool.result` as authoritative and
never recompute lifecycle.**

So the fallback's available data = **name, input (object), result text + isError,
running/done**. Nothing richer exists for an unknown tool.

### 1.3 Dispatcher #1 — `toolViews.jsx` (registry + default) ✅ the good pattern

```js
const DEFAULT = {
  label:        (t) => ({ verb: "Used",    file: t.name ?? "" }),
  runningLabel: (t) => ({ verb: "Running", file: t.name ?? "" }),
  filePath: () => null, stats: () => null, agentRef: () => null,
  Detail: GenericDetail,
};
const VIEWS = new Map();
const register = (name, view) => VIEWS.set(name, { ...DEFAULT, ...view });
export const getToolView = (name) => VIEWS.get(name ?? "") ?? DEFAULT;
```

`ToolItem.PlainToolItem` reads `getToolView(name)` and renders a shared header
(`DisclosureRow` + verb/file/stats/agentRef) plus `<view.Detail tool=… />`. Adding
a tool = one `register()` call. **This is already strategy + registry + open/closed
with a default** — exactly the idiom in `views/registry.js`/`tabs.js` and
`search/index.js`.

### 1.4 Dispatcher #2 — `WorkerToolCard.jsx` ❌ the parallel system

`ToolItem` branches on `isWorkerToolName(name)` (true for the six tools in
`WORKER_TOOL_SPECS`) and hands them to `WorkerToolCard`, which has its **own**
verb map (`WORKER_TOOL_SPECS` in `lib/workerTools.js`), its **own** body map
(`BODIES`), its **own** header (`Target`/`AgentLink`), its **own** `failureKind`,
and **no fallback** (it is unreachable for any name not in the literal map). It
re-implements the same disclosure/expand/failure chrome as `PlainToolItem`.

### 1.5 Custom-vs-fallback inventory (concrete)

| Path | Tools | Treatment |
|---|---|---|
| **Bespoke Detail** (dispatcher #1) | `Read`, `Edit`, `Write`, `Bash`, `AskUserQuestion`, `Skill`, `mcp__orchestrator__ask_user`, `mcp__orchestrator__notify_user`, `mcp__orchestrator__create_worker`, `mcp__orchestrator__list_available_workers`, `mcp__worker__send_message_to_parent`, `mcp__worker__ask_peer`, `mcp__worker__respond_to_peer`, `mcp__worker__list_peers` | full header + bespoke body |
| **Bespoke header only** (dispatcher #1, body = `GenericDetail`) | `Glob`, `Grep`, `WebSearch`, `WebFetch` | custom verb/label, generic body |
| **Bespoke, separate dispatcher #2** | `mcp__orchestrator__spawn_worker`, `kill_worker`, `message_worker`, `get_worker`, `list_active_workers`, `list_pending_permissions` | own header + own body, no fallback |
| **Generic fallback** (`DEFAULT` + `GenericDetail`) | *everything else* — all third-party MCP (`mcp__context7__*`, `mcp__claude_ai_*`, `mcp__firecrawl-mcp__*`, …), `TodoWrite`, `NotebookEdit`, `MultiEdit`, `BashOutput`, `KillShell`, `EnterPlanMode`/`ExitPlanMode`, and any future/unknown tool | `Used <raw name>` header + crude params/output card |

---

## 2. The gap — what a designless tool looks like today

Take `mcp__context7__query-docs` with input `{ libraryId: "/vercel/next.js",
question: "app router caching", tokens: 4000 }` and a 30 KB markdown result.

**Header:** `Used mcp__context7__query-docs` — the raw, double-underscore,
server-namespaced id is the headline. No humanization, and **no args summary** (a
`Read` shows the filename; this shows nothing about *what was queried*).

**Body (`GenericDetail`):**
- Params are `key: String(val)` rows; `libraryId`/`question` are fine but any
  nested/array value becomes a single `JSON.stringify` blob on one line, wrapped
  with `word-break: break-all` (`.gd-val`) → unreadable.
- Output is `result.text.slice(0, 4000)` as monospace pre-wrap; a single huge
  param value is **not** clamped (only the output is).
- **No copy button** (Read/Write/Skill/Bash all have one).
- **No raw-payload view** — you cannot see the full input or full result for
  debugging a misbehaving custom tool.
- While running with no params, `GenericDetail` returns `null` → empty body.

**Why this is the problem to solve:** Eos's whole value is *observing* worker
behaviour. The long tail of tools — every third-party MCP server the user wires
in — is exactly where bespoke renderers will never be written, so the fallback is
what users actually stare at most. Today that fallback leaks implementation ids,
summarizes nothing, and can't be copied or drilled into. The chrome is also
**inconsistently sourced**: `failureKind`/`FailureBanner` logic is duplicated in
three files, and the worker lane bypasses the registry entirely — so "improve the
fallback" currently means editing several places that don't share a contract.

---

## 3. Proposed design

### 3.1 Pattern

Keep the **registry + strategy + default** already present in `toolViews.jsx`, and
make it the **single** path:

- **One contract**: the `ToolView` descriptor (the existing `DEFAULT` shape,
  formalized).
- **One dispatcher**: `getToolView(name)` — already open/closed. Adding a custom
  renderer is `register(name, {…})`; removing one falls back automatically.
- **One generic fallback**: `DEFAULT` (header) + `GenericToolCard` (body). Every
  unregistered tool gets it with zero config.
- **Fold dispatcher #2 into the registry**: re-express the six worker tools as
  `register(...)` entries (header from `WORKER_TOOL_SPECS`, body via a small
  `WorkerToolBody` that keeps the `AgentLink` rows). Delete the
  `isWorkerToolName` branch from `ToolItem`. Result: one dispatch point, one
  fallback, no parallel chrome.

This satisfies SOLID directly: **SRP** (each view owns one tool's presentation;
the fallback owns "unknown tool"), **OCP** (new tools extend via `register`, the
dispatcher/fallback never change), **LSP** (every view — including `DEFAULT` —
honours the same descriptor so `ToolItem` treats them uniformly), **DIP**
(`ToolItem` depends on the `ToolView` abstraction via `getToolView`, not on tool
names).

### 3.2 The `ToolView` contract (formalized; superset of today's)

```js
// toolViews.jsx — the descriptor every tool (custom or fallback) satisfies.
// Pure functions of the parser's `tool` object; no lifecycle recompute.
const DEFAULT = {
  // header
  label:        (t) => ({ verb: "Used",    file: toolDisplayName(t.name) }),
  runningLabel: (t) => ({ verb: "Running", file: toolDisplayName(t.name) }),
  summary:      (t) => argsSummary(t.input),   // NEW: header hint for unknown tools
  filePath:     () => null,   // clickable path (opens viewer) when present
  stats:        () => null,   // {add, del} diff badge
  agentRef:     () => null,   // {id, name} → AgentLink instead of plain file span
  Detail:       GenericToolCard,   // expanded body
};
```

`summary` is new and only the fallback relies on it; bespoke views already encode
their hint in `label.file`, so they ignore it. This keeps the change additive.

### 3.3 Generic fallback anatomy — `GenericToolCard`

Drives entirely off the data budget from §1.2 (name, input, result text+isError,
running/done). Header is rendered by the shared `ToolItem` chrome; the card below
is the body.

```
┌ HEADER (shared ToolItem chrome) ──────────────────────────────┐
│  Used  context7 · query-docs   "app router caching"     ⌄      │  ← humanized name
│        └ verb   └ toolDisplayName(name)  └ argsSummary(input)  │    + arg hint
│  (running → "Running" + shimmer · failed → red "failed" badge) │
└───────────────────────────────────────────────────────────────┘
   ▼ expanded body = GenericToolCard
┌───────────────────────────────────────────────────────────────┐
│  [FailureBanner]   (shared) — only when result.isError         │
│  PARAMETERS                                          [copy ⧉]   │
│    libraryId   /vercel/next.js                                  │  ← pretty value
│    question    app router caching                              │    per-row clamp
│    tokens      4000                                            │
│    options     { depth: 2, … }   (clamped; “raw” reveals full) │
│  OUTPUT                                              [copy ⧉]   │
│    <monospace, clamped to N chars; “+M more” disclosure>       │
│  ▸ Raw payload            (collapsed disclosure)               │  ← NEW
│      { "input": {…}, "result": {…} }   full JSON, copyable     │
└───────────────────────────────────────────────────────────────┘
```

Anatomy decisions:

- **Tool name** → `toolDisplayName(name)`: strip the `mcp__<server>__` prefix and
  render `server · action` (`mcp__context7__query-docs` → `context7 · query-docs`,
  underscores→spaces in the action); non-MCP names pass through (`TodoWrite`). A
  small pure helper in `lib/` (e.g. `toolDisplayName.js`), unit-tested. This is
  the single highest-value fix and is independent of the rest.
- **Args summary** → `argsSummary(input)`: generic, no per-tool knowledge — pick
  the first present of a salience-ordered key list (`file_path`, `path`, `command`,
  `query`, `pattern`, `url`, `name`, …); else the first short string value; else
  nothing. Clamp to ~60 chars. (Mirrors `pendingInputSummary` already in
  `WorkerToolCard.jsx` — reuse/extract it.)
- **Status** → already conveyed by the shared header (shimmer while
  `tool.running`, red badge on `result.isError`). The body adds the
  `FailureBanner` (extracted to one shared component) and a `Running…` placeholder
  instead of returning `null`.
- **Result / error** → existing Output block, but with a copy button and the
  shared `FailureBanner` for `isError`.
- **Expandable raw payload** → NEW collapsed `DisclosureRow` rendering
  `{ input, result }` as pretty JSON with copy — the debugging escape hatch the
  current fallback lacks. Uses the existing `DisclosureRow` so it matches every
  other expander.
- **Pretty params** → render scalars inline; objects/arrays pretty-printed and
  clamped per-row with a "raw" reveal, instead of one `break-all` blob.

All visual primitives already exist (`DisclosureRow`, `.gd-*` classes, the copy
SVG used in `ReadDetail`/`WriteDetail`/`SkillDetail`) — the fallback composes
them; minimal new CSS.

### 3.4 Concrete file touch-points

| File | Change |
|---|---|
| `app/ui/src/views/code/messages/toolViews.jsx` | add `summary` to `DEFAULT`; humanize `DEFAULT.label/runningLabel` via `toolDisplayName`; add the six worker-tool `register(...)` entries (header from `WORKER_TOOL_SPECS`) |
| `app/ui/src/views/code/messages/ToolDetail.jsx` | replace `GenericDetail` with the richer `GenericToolCard` (pretty params, copy, raw-payload disclosure); extract `FailureBanner` to a shared module |
| `app/ui/src/views/code/messages/ToolItem.jsx` | **delete** the `isWorkerToolName` branch — all tools go through `getToolView` |
| `app/ui/src/views/code/messages/WorkerToolCard.jsx` | reduce to a `WorkerToolBody` Detail component (the `AgentLink` rows) registered via `toolViews`, or inline its bodies into registered views; remove the duplicate header/disclosure/failure chrome |
| `app/ui/src/lib/toolDisplayName.js` (new) + `.test.js` | pure name humanizer |
| `app/ui/src/lib/toolArgs.js` (new) or extend `lib/workerTools.js` | `argsSummary(input)` (extract from `pendingInputSummary`) |
| `app/ui/src/styles.css` | additions for raw-payload disclosure / pretty-value rows (reuse `.gd-*`) |
| `app/ui/src/views/code/messages/toolViews.test.js` | extend: `DEFAULT` produces humanized name + summary; worker tools resolve through `getToolView` |
| `lib/messageParser.js` (`isWorkerToolName` usage) | **unchanged** — `laneOf` still uses `isWorkerToolName` for *grouping*; only the *render* dispatch is unified. (Grouping lanes are orthogonal to the renderer and stay.) |

Note: `WORKER_TOOL_SPECS` stays in `lib/workerTools.js` because the parser shares
it for lane grouping + group summaries (`buildWorkerSummary`). The registry
*consumes* it for headers rather than duplicating verbs.

### 3.5 How it slots into existing idioms

It mirrors the repo's established extension idiom (registry of descriptors + a
single resolver): `views/registry.js` + `views/tabs.js` (id→Component), and
`search/index.js` (`{id, getResults}` providers). The `register()`/`Map`/
`getToolView` trio in `toolViews.jsx` is the same shape — this design just removes
the one place (`WorkerToolCard`) that *escaped* the idiom and hardens the default.

---

## 4. Trade-offs / alternatives considered

**A. Strengthen `GenericDetail` only; leave `WorkerToolCard` as-is.** Smallest
diff, fixes the user-visible fallback. But it leaves two dispatchers and three
copies of failure logic — the "one generic fallback that ANY tool gets" goal stays
half-true (worker tools never reach it). *Acceptable as Phase 1, not the end
state.* This is the recommended first increment.

**B. Full consolidation (this design).** One dispatcher, one fallback, one chrome.
Best long-term DRY/OCP; touches `WorkerToolCard` and its tests, slightly larger
blast radius. Recommended end state.

**C. Schema-driven generic renderer** (declare each tool's fields/labels as data,
render generically — no per-tool components). Most "elegant" but over-engineered
for ~18 bespoke tools whose bodies (diffs, Q&A, agent links, skill previews) are
genuinely heterogeneous; it would fight the existing component-per-tool grain and
violate "simplicity first." Rejected.

**D. Move dispatch into the parser** (parser emits a `view` per tool). Couples the
pure parser to JSX/presentation — breaks the current clean split (parser =
data, `toolViews` = presentation). Rejected.

**Risks / watch-items**
- The shared header already conveys running/failed; don't duplicate status in the
  body beyond the `FailureBanner` + a `Running…` line.
- `toolDisplayName` must be pure and well-tested — it changes every fallback
  header and the `getToolView` default snapshot in `toolViews.test.js`.
- Folding worker tools must preserve `AgentLink` click-to-select and the durable
  name resolution (`workerIdentity`/`resultRef`) — these are behavioural, not
  cosmetic; keep them in the registered body.
- Raw-payload JSON can be large → clamp + copy, never render unbounded.

---

## 5. Phased implementation outline (design-only; renderers NOT built here)

1. **Humanize the name** — add `lib/toolDisplayName.js` (+test); use it in
   `DEFAULT.label/runningLabel`. Update `toolViews.test.js` default snapshot.
   *Highest value, smallest risk, independently shippable.*
2. **Enrich the body** — `GenericToolCard`: `argsSummary` header hint, pretty
   params with per-row clamp, copy buttons, `Running…` placeholder. Extract
   `FailureBanner` to a shared module and reuse it.
3. **Raw-payload disclosure** — collapsed `DisclosureRow` with pretty `{input,
   result}` JSON + copy.
4. **Consolidate dispatchers** — register the six worker tools via `toolViews`;
   delete the `isWorkerToolName` branch in `ToolItem`; reduce `WorkerToolCard` to
   a registered `WorkerToolBody`. Keep `WORKER_TOOL_SPECS` for parser grouping.
   Update/extend tests.
5. **CSS pass + visual QA** — verify against a real third-party MCP tool
   (`mcp__context7__query-docs`), a failing tool (denied), and a running tool;
   run `cd app/ui && npm test` and `npm run build`.

Each phase is independently shippable; 1–3 deliver the user-visible win, 4
delivers the architectural cleanup.
