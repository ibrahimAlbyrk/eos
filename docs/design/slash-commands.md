# Backend-agnostic slash commands (design)

Status: DESIGN — research + proposal only, no code changed.
Scope: make a slash command typed in the composer (starting with `/clear`)
behave consistently across **both** backends, and give Eos a clean, SOLID,
open/closed place to add future slash commands.

Two backends are in play, distinguished by `BackendDescriptor` data, never by
`kind` literals (`core/src/ports/AgentBackend.ts:50`):

- **claude-cli** — interactive `claude` over a PTY child, reached over HTTP.
  `processModel: "out-of-process"`, `reportsMessageEvents: true`
  (`manager/backends/ClaudeCliBackend.ts:24`).
- **in-process / SDK lane** — runs inside the daemon, no child process, pushes
  canonical events to `cb.onEvent`. `processModel: "in-process"`,
  `reportsMessageEvents` absent (`infra/src/backends/InProcessBackend.ts:42`).

---

## 1. Current state — how slash input is handled today

### 1.1 There is no slash-command *system*. There are point special-cases.

A composer message is just text. `POST /workers/:id/message`
(`manager/routes/workers.ts:185`) validates `{text, clientMsgId, queueWhenBusy}`
and calls `dispatchMessage` (`core/src/use-cases/DispatchMessage.ts:138`). The
text `"/clear"` travels the **same path as any chat message** — nothing parses
the leading `/` at dispatch time. The only "slash awareness" anywhere is:

- The web lists builtins for discoverability and pill rendering. `/clear` is the
  single entry, explicitly documented as *"sent as a plain message"*
  (`app/ui/src/hooks/useSlashItems.js:5`).
- The composer refuses to *spawn a fresh agent* from `/clear` but otherwise
  sends it normally (`app/ui/src/views/code/center/Composer.jsx:491`).

So "slash handling" today = **(a)** literal text forwarded to whatever the
backend does with it, plus **(b)** a few daemon-side control verbs that are
*modeled as their own endpoints/use-cases*, not as slash commands. The control
verbs are the de-facto pattern a real system would generalize.

### 1.2 The "control traffic" pattern (the seam to generalize)

The contract that separates a chat message from a control send is the optional
**`record`** on a delivery (`contracts/src/http.ts:116`, `MessageRecordSchema`
at `:127`): *"Absent → control traffic (slash commands) that must produce no
chat event."* When a send carries no `record`, no `user_message` event is
emitted; the text is delivered to the backend purely for its side effect.

Existing control verbs, each its own endpoint + use-case, each
capability-gated on `AgentCapabilities` (`core/src/ports/AgentBackend.ts:21`):

| Verb | Entry | Capability | How it reaches the backend |
|------|-------|-----------|----------------------------|
| `/model`, `/effort` | `PUT /workers/:id/model` (`manager/routes/workers.ts:552`) → `setWorkerModel` (`core/src/use-cases/SetWorkerModel.ts:37`) | `runtimeModelSwitch` | `session.setModel()` → CLI sends `/model`+`/effort` as record-less messages (`manager/backends/ClaudeCliBackend.ts:64`); SDK no-ops (`infra/src/backends/InProcessBackend.ts:100`) |
| `/permissions` | `PUT /workers/:id/permission` (`manager/routes/workers.ts:540`) → `setWorkerPermissionMode` (`core/src/use-cases/SetWorkerPermissionMode.ts:40`) | `runtimePermissionSwitch` | **Legacy** `client.sendMessage(port, "/permissions ...")` — bypasses the backend abstraction (`SetWorkerPermissionMode.ts:57`) |
| interrupt (Esc) | `POST /workers/:id/interrupt` → `interrupt-worker.ts` | `interrupt` | `session.interrupt()` — CLI writes `\x1b`; SDK aborts the loop (`manager/commands/handlers/interrupt-worker.ts`) |
| keystroke | `POST /workers/:id/keystroke` (`manager/routes/workers.ts:413`) | `keystroke` | `httpWorkerClient.sendKeystroke(port)` → PTY raw write (`spawner/worker.ts:529`); SDK returns `{ok:false}` (`InProcessBackend.ts:92`) |

`interrupt-worker.ts` is the **best existing template**: resolve backend by
`backend_kind`, `backend.attach(handle)`, gate on `session.capabilities.X`,
run the effect, then do the daemon-side bookkeeping (clear pending queue, cancel
peer requests, mark the settle window). A slash-command system should look like
this, generalized.

### 1.3 Where `/clear`'s partial handling lives

`/clear` has **no dispatch-time handling at all** — it is intercepted only
*reactively, after the fact, and only on the CLI lane*:

1. Text `/clear` is forwarded to the PTY exactly like a chat message
   (`worker.ts:516` `onMessage` → `dispatchToPty` `:443` → `deliver`). The
   **claude TUI itself** interprets `/clear` and resets its session.
2. claude fires a `SessionEnd` hook with `reason: "clear"`. The worker sees it
   (`worker.ts:676`), and because `/clear` rolls the session to a new id +
   new transcript file, it polls disk for the new transcript and retargets the
   tail (`watchForClearedSession` `worker.ts:498` → `swapSession` `:480`).
3. The worker forwards that hook to the daemon (`spawner/events.ts:45`,
   `POST /workers/:id/events`; hook wired in `spawner/settings.ts:53`).
4. The daemon's events route recognizes `hook + SessionEnd + reason==="clear"`
   and runs the **only daemon-side `/clear` logic that exists**
   (`manager/routes/workers.ts:168`-`181`):
   - `c.messageQueue.clearPending(id)` — a fresh context must not inherit the
     old queue (`:174`).
   - `c.pendingPeerRequests.cancelByWorker(id)` — drop outstanding peer asks
     (`:177`).
   - append a synthesized `conversation_cleared` event (`:178`,
     enum at `contracts/src/events.ts:68`).
5. The web hides everything before that boundary: `messageParser.js:33` slices
   the event list at `conversation_cleared`, and `:348` renders the divider —
   the optimistic `/clear` bubble disappears with the rest of the history.

**Key fact for the design:** the `/clear` side effects (queue clear, peer
cancel, history boundary) are **triggered by a CLI-only hook**, not by the act
of dispatching `/clear`. The in-process lane never produces that hook, so none
of it runs there.

---

## 2. The gap — why `/clear` is a no-op on the SDK lane

On the in-process lane, `dispatchMessage` resolves the backend by
`backend_kind` (`DispatchMessage.ts:150`), finds `processModel:"in-process"`,
and calls `session.sendMessage("/clear")`. That lands in
`InProcessBackend.sendMessage` (`infra/src/backends/InProcessBackend.ts:86`) →
`kickTurn` (`:69`), which does:

```
s.messages.push({ role: "user", content: "/clear" });   // InProcessBackend.ts:71
runTurn(...)                                             // a normal model turn
```

So `/clear`:

- is appended to the conversation as a literal user message,
- starts a model turn that sees the string `/clear` and does nothing useful,
- emits **no** `SessionEnd` hook (there is no claude TUI; in-process backends
  have no hook channel),
- therefore never triggers `manager/routes/workers.ts:171`, so the queue is
  not cleared, peer requests are not cancelled, and **no `conversation_cleared`
  event is appended** — the web history is never sliced.

Net: on the SDK lane `/clear` literally adds noise to the context instead of
resetting it. It is a no-op-with-side-effects.

### What "clear the conversation" must mean per lane

Both lanes must converge on the same observable outcome — agent context wiped,
chat view reset, queued/peer state dropped — realized by different primitives:

| Effect | claude-cli (PTY) | in-process / SDK |
|--------|------------------|------------------|
| Reset agent memory/context | Drive the CLI's **native `/clear`** (forward the text; the TUI rolls to a new session id + new transcript) | Reset session state directly: `messages = []`, clear the abort flag — a new primitive on the in-process session |
| Retarget transcript tail | `swapSession` after disk poll (`worker.ts:480`) — already exists | N/A (no transcript file; events are synthesized) |
| Emit `conversation_cleared` | Synthesized from the `SessionEnd(clear)` hook today (`workers.ts:178`) | Must be synthesized by the daemon directly (no hook to ride) |
| Clear pending queue + peer asks | Hook-driven today (`workers.ts:174-177`) | Must be driven by the command directly |

The CLI lane already does the right thing end-to-end; the SDK lane needs a
context-reset primitive **and** the daemon-side bookkeeping that the CLI lane
currently gets "for free" from the hook.

---

## 3. Proposed architecture

A SOLID, backend-agnostic slash-command system with three parts: a **registry**
of declarative command modules (open/closed), a single **daemon-side
interception chokepoint**, and a **per-backend capability** each command resolves
to. It mirrors idioms already in the repo (MCP `tool-registry.ts`, CLI command
`registry.ts`, the data-only `MODE_SPECS` permission table).

### 3.1 The abstraction

```
// core/src/domain/slash-command.ts  (pure, no Node imports)

export interface SlashCommandContext {
  workerId: string;
  args: string;                       // text after the command name, trimmed
  session: AgentSession;              // already attached by the chokepoint
  caps: AgentCapabilities;            // session.capabilities (branch on DATA)
  services: SlashSideEffects;         // queue/peer/events/settle/bus — see 3.4
}

export interface SlashCommandResult {
  handled: boolean;                   // false → fall through to a normal turn
  status: number;
  body: unknown;
}

export interface SlashCommand {
  readonly name: string;              // "clear" (matched WITHOUT the slash)
  readonly description: string;       // discoverability (served to the web)
  readonly aliases?: readonly string[];
  // True only when this command can complete given the session's caps + args.
  // false → the chokepoint must NOT intercept (fall through to a normal turn /
  // native passthrough). Keeps unknown/partial input flowing as plain text.
  accepts(args: string, caps: AgentCapabilities): boolean;
  execute(ctx: SlashCommandContext): Promise<SlashCommandResult>;
}

export interface SlashCommandRegistry {
  get(name: string): SlashCommand | undefined;   // exact name/alias match
  list(): SlashCommand[];                         // for the discoverability endpoint
}
```

Why this shape:

- **OCP / "registry" idiom** — adding a command is registering a module, never
  editing `dispatchMessage`, the route, or the `AgentBackend` port. This is the
  directive's "open for extension" requirement, and matches `tool-registry.ts`.
- **ISP** — a command receives only the seams it needs (`SlashSideEffects`),
  not the whole daemon container.
- **DIP** — commands depend on the `AgentSession` / `AgentCapabilities`
  abstractions, never on a backend `kind`. Capability gating is **data**, exactly
  like `SetWorkerModel.ts:63` and `interrupt-worker.ts`.

### 3.2 Mapping a command to a per-backend capability

A command resolves "what to do" against the session's capabilities. For
context reset we need **one** new narrow primitive on the existing port rather
than a god-method:

```
// core/src/ports/AgentBackend.ts — additions
interface AgentCapabilities {
  // ...existing flags...
  readonly contextClear?: boolean;    // backend can reset conversation in place
}
interface AgentSession {
  // ...existing methods...
  // Reset the live conversation/context. CLI: forward native /clear over the
  // PTY (the TUI rolls the session). SDK: messages=[] + clear abort. Backends
  // without contextClear never receive this call (the command gates on the flag).
  clearContext?(): Promise<{ ok: boolean }>;
}
```

Per-backend realization of `/clear`:

- **claude-cli** (`contextClear: true`): `clearContext()` forwards the native
  `/clear` text over the existing record-less message channel
  (`ClaudeCliBackend.ts:59`, same mechanism `setModel` already uses at `:64`).
  The TUI clears; `swapSession`/tail retarget stay as-is.
- **in-process** (`contextClear: true`): `clearContext()` resets the
  `LiveSession` — `s.messages = []`, `s.signal.aborted = false`
  (touching `InProcessBackend.ts:32`/`:69`). No turn is kicked.

This is deliberately the *same grain* as the existing control verbs: one
capability flag + one session method + capability-gated callers. New commands
that need no new primitive (pure daemon-side, or pure native passthrough) add
**zero** port surface.

> Design note — keep `/clear` as one command with two capability impls, **not**
> two code paths. "Native CLI clear" and "SDK context reset" are two
> realizations of the single `clearContext` capability, selected by data.

### 3.3 WHERE interception happens — the chokepoint (decision needed)

The interception must live **daemon-side**, and the strongest spot is the head
of `dispatchMessage` (`DispatchMessage.ts:138`), because that one function is
called by *both* the live route (`workers.ts:220`) **and** the queue drain
(`DrainQueuedMessages.ts:58`). Intercepting there means a `/clear` that was
queued while the worker was WORKING is still treated as a command when it
drains, with no extra wiring.

Worker-side interception is rejected as the primary seam: the in-process lane
has **no worker process**, so a worker-side parser cannot serve both backends.
The CLI worker keeps its existing job (forwarding native text to the PTY) — that
becomes the CLI realization of `clearContext`, not the interception point.

Proposed flow inside `dispatchMessage`, inserted **after** the idempotency
claim (`DispatchMessage.ts:200`) and **before** `backend.sendMessage`
(`:245`):

```
const cmd = parseSlash(input.text, registry);     // exact first-token match
if (cmd) {
  deps.clearTurnSettle?.(workerId);               // genuine new "turn"
  const session = backend.attach(workerId, handle);
  if (cmd.accepts(args, session.capabilities)) {
    return await cmd.execute({ workerId, args, session, caps, services });
  }
  // not accepted (incapable backend / bad args) → fall through to normal send
}
// ...existing normal-message dispatch...
```

`parseSlash` intercepts **iff** the trimmed text's first token exactly equals a
registered name/alias. Everything else (plain chat, claude-native commands Eos
doesn't own like `/compact`, partial `/cle`, unknown `/foo`) flows through
untouched — see §5.

### 3.4 Interaction with queue / settle / transcript machinery

The command's side effects must be **centralized in the command**, run for both
lanes, replacing the CLI-only hook reaction. `SlashSideEffects` exposes exactly
what `/clear` needs, all already present in the container and used by
`interrupt-worker.ts` and `workers.ts:168-181`:

- `clearPendingQueue(id)` → `c.messageQueue.clearPending` (today `workers.ts:174`)
- `cancelPeerRequests(id)` → `c.pendingPeerRequests.cancelByWorker` (today `:177`)
- `appendConversationCleared(id, payload)` → `c.events.append(... "conversation_cleared")`
  (today synthesized at `:178`)
- `clearTurnSettle(id)` / `markSettling(id)` → `TurnSettleService`
- `publishChange(id)` → `c.bus.publish("worker:change")`

`/clear` semantics: clear pending queue (incl. itself and rows behind it),
cancel peer asks, append `conversation_cleared`, do **not** emit a
`user_message` (it carries no `record` — `MessageRecordSchema` "absent → control
traffic", `contracts/src/http.ts:116`). On the CLI lane the native `/clear`
still fires its `SessionEnd(clear)` hook; the existing handler at
`workers.ts:171` must become **idempotent / suppressible** so the queue isn't
double-cleared and a second `conversation_cleared` isn't appended (see §3.5).

Settle window: `/clear` ends the conversation, so it behaves like interrupt —
`markSettling` plus `clearPending` mirrors `interrupt-worker.ts`. On the CLI
lane the trailing JSONL of the abandoned session is naturally orphaned by
`swapSession` retargeting the tail to the new session id.

### 3.5 Web input + optimistic bubbles when a slash command runs

The web path needs **no structural change**; it already round-trips `/clear`
correctly on the CLI lane, and the SDK lane converges once the daemon emits
`conversation_cleared`:

- The composer sends `/clear` through the normal optimistic `sendOne`
  (`Composer.jsx:456`) → `outbox.beginSend` (`state/outboxStore.js:63`) with a
  `clientMsgId`. An optimistic bubble appears.
- The daemon command returns quickly; `settleSend` (`outboxStore.js:82`)
  resolves the row. Because the command emits **no** `user_message`, the
  bubble is reconciled away when the history is sliced.
- Both lanes append `conversation_cleared`; `messageParser.js:33` slices all
  events before it, so the optimistic `/clear` bubble and the prior history
  vanish together — identical UX across backends.

Two web follow-ups (improvements, not blockers): (a) `BUILTIN_COMMANDS` is
hardcoded in `useSlashItems.js:7` — it should be fed by a daemon endpoint that
serves `registry.list()` so new commands surface without a web edit; (b) the
composer's `/clear` guard (`Composer.jsx:491`) stays, but new commands should
declare their own "needs a selected worker" metadata rather than special-casing.

### 3.6 Component diagram

```
composer ──/clear──▶ POST /workers/:id/message ──▶ dispatchMessage
                                                      │  (chokepoint, §3.3)
                                                      ▼
                                          parseSlash(text, SlashCommandRegistry)
                                                      │ hit
                                                      ▼
                                          SlashCommand.execute(ctx)
                                              ├─ session.clearContext()  ──▶ CLI: native /clear over PTY
                                              │                              SDK: messages=[] + abort reset
                                              └─ SlashSideEffects:
                                                   clearPendingQueue / cancelPeerRequests
                                                   appendConversationCleared / settle / bus
   (queue drain also calls dispatchMessage ──▶ same chokepoint, no extra wiring)
```

---

## 4. Extensibility — adding a new slash command

Mirrors the "Adding new things" list in `CLAUDE.md`. To add `/<name>`:

1. **Command module** — `core/src/domain/commands/<name>.ts` (or
   `manager/slash/commands/<name>.ts` if it needs manager-only services)
   implementing `SlashCommand`: `name`, `description`, `accepts()`,
   `execute()`. Register it in the slash registry (one line), exactly like
   `tool-registry.ts` / CLI `registry.ts`.
2. **Capability (only if it needs a new backend primitive)** — add a flag to
   `AgentCapabilities` and a method to `AgentSession`
   (`core/src/ports/AgentBackend.ts`), then implement it in each adapter
   (`ClaudeCliBackend.ts`, `InProcessBackend.ts`). Commands that are pure
   daemon-side or pure native-passthrough add nothing here.
3. **Side effects (only if it touches new daemon state)** — add a method to
   `SlashSideEffects` and bind it in the container; reuse existing services
   (`messageQueue`, `pendingPeerRequests`, `events`, `turnSettle`, `bus`)
   wherever possible.
4. **Event type (only if it appends a new chat marker)** — add to the enum in
   `contracts/src/events.ts` and render it in `app/ui/src/lib/messageParser.js`.
5. **Discoverability** — once §3.5(a) lands, nothing: the command surfaces via
   the registry endpoint. Until then, add an entry to
   `app/ui/src/hooks/useSlashItems.js:7`.
6. **Tests** — a `core` unit test for `accepts`/`execute` against a
   `FakeAgentBackend`, and a `DispatchMessage` test that interception
   short-circuits the normal turn and the drain path re-intercepts.

No change to `dispatchMessage`, the `/message` route, or the queue/drain code
for any new command — that is the open/closed payoff.

---

## 5. Edge cases & risks

- **Queue draining.** A `/clear` sent while the worker is WORKING is held in the
  daemon queue (`DispatchMessage.ts:171`) and dispatched at the next IDLE
  (`DrainQueuedMessages.ts:58`). Because interception lives inside
  `dispatchMessage` (§3.3), the drained `/clear` is still treated as a command,
  not delivered as literal text. Define semantics: when `/clear` executes it
  clears **all** remaining pending rows (itself + any queued behind it) — a
  fresh context must not inherit the old queue (consistent with today's
  `workers.ts:174` and interrupt's `clearPending`).

- **Turn-settle window.** `/clear` ends the conversation, so the command must
  `markSettling`/`clearTurnSettle` like `interrupt-worker.ts`; otherwise
  trailing JSONL of the killed session could re-animate the worker to WORKING.
  On the CLI lane `swapSession` retargets the tail so the abandoned session's
  late lines are dropped.

- **`clientMsgId` idempotency.** The composer always generates a `clientMsgId`
  (`Composer.jsx:459`). Interception must sit **after** the idempotency claim
  (`DispatchMessage.ts:200`) so a duplicate `/clear` POST is deduped exactly
  like a duplicate message — a double-tap can never clear twice. Risk: the
  unkeyed `hasRecentDispatch` ledger (`DispatchMessage.ts:213`) shouldn't record
  a command as a re-sendable "message"; commands should skip the ledger insert
  at `:267`.

- **Double-handling on the CLI lane.** Native `/clear` still fires
  `SessionEnd(clear)`, and the existing handler (`workers.ts:171`) re-runs the
  queue clear + appends a second `conversation_cleared`. The command and the
  hook must be reconciled: either (a) make the hook handler idempotent (no-op if
  a `conversation_cleared` was just appended by the command), or (b) suppress
  the command's daemon-side effects on `contextClear`-native-passthrough
  backends and let the hook keep owning them on the CLI lane. **(a) is
  recommended** — uniform behavior, the hook becomes a self-heal fallback.

- **What clears vs what persists.** Clears: agent context/memory, chat history
  view (via `conversation_cleared`), pending queue rows, outstanding peer asks.
  Persists: worker identity/row, model + effort, permission mode, backend kind,
  worktree/branch, parent/child links. (Matches `/clear`'s
  "Clear conversation history" label, `useSlashItems.js:8`.)

- **Partial-typed commands.** `/cle`, `/clear ` (trailing junk that isn't valid
  args), `/cl` must **not** intercept — `parseSlash` requires an exact
  first-token name/alias match and `accepts()` must validate args. Anything that
  fails flows as a normal message, so a user can still literally type text
  starting with `/`.

- **Unknown commands (allowlist, not denylist).** The registry is an
  **allowlist** of Eos-owned commands. An unknown `/foo` is **never** swallowed:
  on the CLI lane it passes through to the TUI (so claude-native commands like
  `/compact`, `/rewind` still work); on the SDK lane it reaches the model as
  literal text — a known, accepted limitation (note it; a future SDK-side
  "unknown command" UX could reject it explicitly).

- **`/permissions` inconsistency (pre-existing).** `SetWorkerPermissionMode.ts:57`
  still drives the PTY via the legacy `client.sendMessage(port, ...)` instead of
  the backend session — it will silently do nothing on the SDK lane. Folding
  `/permissions` into the slash system (capability-gated like `setModel`) would
  fix that, but it is out of `/clear`'s scope; flag as follow-up.

---

## 6. Decisions needing operator sign-off

1. **CLI-lane `/clear` side-effect ownership (the one real fork).** Either
   (a) **command-owns + hook-as-fallback** — the command runs the daemon-side
   effects for both lanes and the `SessionEnd(clear)` handler at
   `workers.ts:171` becomes idempotent (recommended: uniform, hook self-heals);
   or (b) **keep the CLI lane hook-driven** and have the command run those
   effects only for in-process backends. (a) is cleaner; (b) is lower-risk
   (CLI behavior byte-for-byte unchanged) but leaves the two lanes asymmetric.

2. **Interception site.** `dispatchMessage` head (recommended — single
   chokepoint shared by the live route and the drain) vs the `/message` route
   only (drain would need its own interception). Recommend `dispatchMessage`.

3. **New port surface for context reset.** Add a narrow `contextClear`
   capability + `clearContext()` to `AgentSession` (recommended, matches the
   existing per-verb grain) vs a single generic `applyControl(intent)` seam
   (fewer port edits long-term, but a looser contract). Recommend the narrow
   method for `/clear`; revisit a generic seam only if command count grows.

4. **Scope of the first cut.** `/clear` only, or also migrate `/model` /
   `/permissions` / interrupt into the registry in the same pass. Recommend
   `/clear` only first (smallest correct change), then migrate the others to
   prove the abstraction and fix the `/permissions` SDK gap.

---

## 7. Follow-up implementation work (not done here)

- Implement `SlashCommand` / `SlashCommandRegistry` (`core/src/domain`) + a
  `clear` module.
- Add `contextClear` cap + `clearContext()` to the port and both adapters.
- Insert the chokepoint in `dispatchMessage`; make `workers.ts:171` idempotent.
- Wire `SlashSideEffects` in the container from existing services.
- Serve `registry.list()` over HTTP and feed `useSlashItems`.
- Tests: core unit, `DispatchMessage` interception + drain, an SDK-lane `/clear`
  end-to-end against `FakeAgentBackend`.
- Stretch: migrate `/model`/`/permissions`/interrupt onto the registry; fix the
  `/permissions` SDK no-op.
