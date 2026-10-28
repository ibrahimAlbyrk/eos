# Multiple accounts per provider + auto-switch

Sign in to several plans of the same provider. Sessions start on the
provider's **default account**; when the account a session runs on hits its
plan limit, the session moves to the account with the most room left and
picks the turn back up — same worker, same transcript, same context. The
switch is quiet: one divider row in the transcript, nothing in the composer.

Design: canvas option **A · Quiet pool** (composer shows only the provider;
the default account is chosen in Settings › Accounts).

## What the design rests on

- `claudeStoreService(dir)` names the Keychain item per store dir
  (`"Claude Code-credentials-" + sha256(dir)[0:8]`), so N dirs hold N
  logins — and a store can't be moved without losing its login.
- **Claude transcripts are shared** (`~/.claude/projects/…`; only secure
  storage moves with `CLAUDE_SECURESTORAGE_CONFIG_DIR`), so a session started
  on one sign-in resumes on another as it is. Codex (`$CODEX_HOME`) and
  Gemini (`$GEMINI_CLI_HOME`) keep sessions inside the per-login home.
- The SDK reports a plan limit as `rate_limit_event` (`status: rejected`,
  `resetsAt`; `sdk.d.ts` `SDKRateLimitInfo`) and ends the turn with the
  CLI's own assistant message (`assistant.error`) and a `success` result
  with `is_error: true`.

## Scope

- **Claude only.** Several Claude sign-ins, a default, and live auto-switch on
  the claude lane.
- Not needed: several ChatGPT / Gemini sign-ins and their live switch. The
  design stays provider-agnostic, so they plug in without rework: a
  `SubscriptionProvider` sets `multiLogin` + `describe()` and signs in to the
  store dir it is given (`codexSubscription` / `geminiSubscription`),
  `codexEnv` / `geminiEnv` in `container.ts` read the session login's store the
  way `claudeStore()` does, and `planLoginDirs` already names `codex-<id>` /
  `gemini-<id>` dirs. Open question then: both CLIs keep chat history inside the
  per-login home, so resuming after a default change needs a shared history dir.
- Not in scope: switching before a limit (threshold / balancing), per-session
  manual account picker in the composer, syncing accounts between Macs.

## Model

A provider's sign-ins are **plan logins** (`PlanLogin` in contracts,
`PlanLoginRecord` daemon-side); "account" stays the per-provider
`AccountStatus` it always was.

```
PlanLoginRecord {            // core/src/domain/plan-logins.ts
  id: "lg-<12 hex>"
  provider: "anthropic" | "openai" | "gemini"
  label: string              // user-editable; the email until renamed
  email?: string             // read after sign-in, used to dedupe
  storeDir: string           // daemon-only, never in a response
  createdAt: ISO
}
PlanLoginRegistry { logins[], defaults: { [provider]: loginId }, autoSwitch?: { [provider]: boolean } }
AccountStatus += { logins?: PlanLogin[], defaultLoginId?, autoSwitch? }   // PlanLogin = id, label, email?, plan?, state, limitedUntil?
PlanLimitMark { reason: "limit" | "expired", until? }   // PlanLimitLedger, per login, in memory
```

- Registry file `~/.eos/accounts/logins.json` (0600, `FilePlanLoginStore`),
  under the `accounts` entry of the user-data manifest. Not synced —
  credentials are per Mac. One write path: `core/src/services/PlanLoginService`.
- Store dirs: a new sign-in gets `~/.eos/accounts/<cli>-<loginId>/`
  (`infra/src/auth/planLoginDirs.ts`); a signed-out store moves to
  `accounts/.trash/`, a sign-in that never finished leaves nothing.
  **Migration:** the existing `~/.eos/accounts/claude` login is adopted in
  place as the first sign-in at boot (its `storeDir` keeps the old path, so
  its Keychain item still matches) and becomes the default.
- A fresh sign-in to an email that is already listed takes that sign-in's
  place (label kept); the replaced store is signed out and trashed.
- Limits live in memory in `PlanLimitLedger` (a daemon restart forgets
  them; the next limited turn marks the sign-in again).
- The billing rule stays: a provider with sign-ins that all stopped working
  is `blocked`; subscriptions only ever switch to other subscriptions. The
  API key is **never** an automatic fallback.

## Layers (dependency direction contracts → core → infra → manager)

**contracts**
- `accounts.ts`: `PlanLoginSchema` (`state`, `limitedUntil?`);
  `AccountStatus.logins` / `defaultLoginId` / `autoSwitch`;
  `SignInSession.loginId` (the sign-in being renewed); `SignInStartRequest`,
  `PlanLoginRenameRequest`, `DefaultLoginRequest`, `AutoSwitchRequest`.
  Redacted as before (`storeDir` never leaves).
- `events.ts`: synthesized rows `account_switched { provider, from?, to,
  reason: limit | expired | reset | api_key, resetsAt? }` (labels at the
  time) and `accounts_exhausted { provider, nextResetAt?, apiKey, resumeAt?,
  resumed? }` (its actions patch the row's payload).
- `usage.ts`: `ProviderUsage.loginId` / `label` — one snapshot per sign-in.
- `PlanLogin.inUse` — live sessions on the sign-in.

**core**
- `domain/plan-logins.ts` — the registry (logins, per-provider default and
  auto-switch, on unless set) and its pure edits; `sessionLoginOf` is the one
  pick: the default while usable, else the oldest usable.
- `services/PlanLoginService` — the one write path; `PlanLoginReader` is
  what the spawn path and the Accounts list read. `runnableLogin` picks a
  ready sign-in, else (every one at its limit) a limited one — its turn then
  meets the limit like any other; null only when none is signed in.
- `services/PlanLimitLedger` — in memory: `mark(loginId, limit | expired,
  until?)`, `readiness(loginId, signedIn) → ready | limited | out`. A limit
  lifts at its reset (no reset given → retried after an hour); expired stays
  out until a sign-in renews it (`SignInService.onSignedIn` → `clear`).
- Port: `capabilities.accountSwitch` + `AgentSession.switchAccount(credential)`
  with `SessionCredential = { storeDir } | { apiKey: true }` — restart the
  live session, same conversation, on that credential; later launches (/clear,
  compaction, recall) stay on it. Gated on the flag, never on backend kind.
- `use-cases/SwitchSessionAccount` — the session's sign-in can't run (limit
  or expired): ledger mark, then `PlanOutcome`:
  - **switched** — auto-switch on and another sign-in ready: `switchTarget`
    (most room left in its 5-hour window, unknown = none; ties → default,
    then oldest) → `moveSession`.
  - **exhausted** — no other sign-in ready: record `accounts_exhausted`
    (earliest reset among the limited, whether an API key is set) and fire
    the macOS banner "Claude accounts are out".
  - **kept** — anything else; the turn ends as it did.
- `moveSession` (same file) — the one way a session changes credential:
  `switchAccount` → record `account_switched` → send the `accounts/continue`
  prompt via `sendMessage` (records no user row, so it never shows).
- `use-cases/ContinueOnApiKey` — the exhausted row's "Use API key": refuses
  without a key, else `moveSession(..., { apiKey: true })`.

**infra**
- `FilePlanLoginStore` (logins.json, atomic 0600 write) and `planLoginDirs`.
- `ClaudeUsageProvider` takes `login()` → its id is `usageKey("claude",
  loginId)` and its snapshots carry `loginId` / `label`.

**manager**
- `AccountsService` lists Claude's sign-ins with their ledger state and the
  sign-in the provider bills (`runnableLogin`). `SignInService` signs in to
  prepared stores, dedupes by email (`<storeDir>/.claude.json`).
- `services/PlanResumeService` — the exhausted row's "Resume at": one
  in-memory timer per agent (reset + 30 s slack), the schedule on the row's
  payload; on fire, only if the agent is IDLE with no user message since the
  row and a sign-in is ready → `moveSession` (reason `reset`).
- `UsageService` reads its provider list live (`providers: () => …`): one
  Claude provider per sign-in (the legacy setup-token one when there are
  none); `peek()` serves the last snapshots without fetching.
- `container.ts`: `claudeStore()` = `runnableLogin` over the ledger's
  readiness; ClaudeSdkBackend deps `onPlanUnusable` → `switchSessionAccount`
  (with `used` = the sign-in's 5-hour use from `usage.peek()`) and
  `onLaunchCredential` → which store each live session runs on (Settings'
  "In use"). The dream usage gate reads the snapshot of the sign-in a dream
  would run on.

## Detection (claude lane)

- `rate_limit_event` with `status: rejected` marks the turn's plan limit
  (`resetsAt`, epoch seconds → ms).
- The CLI writes its own assistant message when the plan can't answer
  (`assistant.error`). For `rate_limit` and `authentication_failed` the
  mapper holds that message until the turn's `result` and never takes it as
  the recall anchor.
- At `result`: `authentication_failed` → `expired`; `rate_limit` after a
  rejected event → `limit` (with its reset); a `rate_limit` the plan didn't
  reject is a transient 429 → no switch. `mapper.takeUnusable()` hands it on.
- The lane holds that `result` batch and calls `onPlanUnusable` without
  blocking the stream. switched → this launch is no longer current and the
  batch is dropped (the user sees only the divider); exhausted → the batch
  goes out without the CLI's notice (the amber row replaces it); kept → the
  notice and the batch go out, exactly as before. A session on the API key
  never asks.

## Continuing the turn

The new launch resumes the **same** session id (transcripts are shared by
every store; no fork), then the hidden `accounts/continue` prompt asks the
model to continue from where it stopped. The CLI's own
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` re-runs only turns a restart cut off,
not one that ended on a limit, so it isn't used. The user's prompt is never
re-sent — that would re-run tools.

## Routes (contracts/src/http.ts, all ui-token)

| Route | Purpose |
|---|---|
| `GET /api/accounts` | every provider; Claude with `logins`, `defaultLoginId`, `autoSwitch` |
| `POST /api/accounts/:provider/sign-in` `{ loginId? }` | add a sign-in, or sign `loginId` in again |
| `PUT /api/accounts/:provider/logins/:id` `{ label }` | rename |
| `DELETE /api/accounts/:provider/logins/:id` | sign out + remove (its store dir → `accounts/.trash/`) |
| `PUT /api/accounts/:provider/default-login` `{ loginId }` | the default sign-in |
| `PUT /api/accounts/:provider/auto-switch` `{ enabled }` | the auto-switch toggle |
| `PUT /workers/:id/plan-resume` `{ rowId, on }` | schedule / cancel the exhausted row's "Resume at" |
| `POST /workers/:id/api-key-continue` | the exhausted row's "Use API key" (this session only) |

## UI (app/ui)

- `components/accounts/PlanLoginsCard` (Claude once signed in): rows (avatar,
  label + plan pill, email, "At limit · resets 16:40" / "Signed out" /
  "Sign-in expired", Rename, Sign out, Sign in again), and with two or more
  sign-ins the default account select and the auto-switch toggle; the API key
  row. `accountsStore`: `removeLogin`, `renameLogin`, `setDefaultLogin`,
  `setAutoSwitch`.
- Rows also show the sign-in's 5-hour use (bar + "38% used", from
  `useUsage`) and "In use" with its live session count.
- Transcript: `messageParser` → `accountSwitched` →
  `views/agents/messages/AccountSwitchLine.jsx` — the centered divider
  "Continued on Work · Personal resets 16:40" (also "its limit reset",
  "billed per token"); `accountsExhausted` → `AccountsExhaustedRow.jsx` — the
  amber row with "Resume at 16:40" (then "Continuing at 16:40 · Cancel") and
  "Use API key" when a key is set.
- Usage tab and account menu: a section per sign-in ("Claude · Personal ·
  Max"; the menu labels each block of rings).
- Composer: unchanged — only the provider name.

## SOLID, concretely

- **S** — registry (sign-ins + settings), ledger (who can't run), mapper
  (detection), lane (relaunch on a store), use-case (the decision).
- **O** — another provider = its `SubscriptionProvider` with `multiLogin`, its
  env reading the session login's store, and its lane's `takeUnusable` /
  `switchAccount`; registry, ledger and use-case stay untouched.
- **L** — a session either implements `switchAccount` and declares
  `accountSwitch`, or declares neither.
- **I** — narrow faces: `PlanLoginReader` (read), `PlanLogins` (sign-in
  writes), `Pick<PlanLimitLedger, …>` (Accounts list).
- **D** — core depends on ports only; `container.ts` wires the adapters.

## Phases (each shippable)

1. **Done.** Several Claude sign-ins, the default, Settings UI, adoption of
   the existing login; every new claude run uses `claudeStore()`.
2. Dropped — sessions resume on the default sign-in (Claude's transcripts
   are shared, so no per-session record is needed).
3. **Done.** Limit / expired detection, ledger, `SwitchSessionAccount`, the
   transcript divider, the auto-switch toggle, "At limit" in Settings; with
   every sign-in out, the amber row (Resume at / Use API key) and the macOS
   banner.
4. **Done.** Usage per sign-in (rows' 5-hour bar, "In use", Usage tab,
   account menu); the switch picks the ready sign-in with the most room left.
5. Dropped — Claude only.

## Tests

- core: `PlanLoginService`, `PlanLimitLedger`, `runnableLogin`,
  `SwitchSessionAccount` (most room left, default first, skips limited/signed
  out, exhausted row + banner, expired, auto-switch off, incapable/failed
  switch), `ContinueOnApiKey`.
- manager: `sdk-plan-switch.test.ts` (mapper fixtures for rejected limit,
  transient rate limit, auth failure, per-turn reset; the lane resuming on
  the new store, dropping the failed turn's end or just the notice, the API
  key env, launch-credential reports), `PlanResumeService`, `UsageService`
  (live providers, per-sign-in snapshots), `AccountsService` (in use),
  `SignInService`, routes; infra `ClaudeUsageProvider` login tag.
- ui: `accountsStore`, `messageParser` (`accountSwitched`,
  `accountsExhausted`), `PlanLoginsCard`, `AccountSwitchLine`,
  `AccountsExhaustedRow`, `PlanCards`, `usageFormat`.
