# Design: Centralized Prompt System + Dynamic Prompt Injection (DPI)

Status: Proposed · Author: design report · Scope: `contracts/` `core/` `infra/` `manager/` `spawner/`

## 0. TL;DR

Two layers, built bottom-up:

1. **Prompt System** (Layer 1) — a centralized, daemon-side catalog of named prompt
   templates with declared variables. One API: *"give me prompt `X`"* (globals auto-filled)
   or *"give me prompt `X` with `var = value`"* (locals override). Pure templating; knows
   nothing about sessions or conditions.

2. **DPI** (Layer 2) — sits on top. At **session start** it gathers runtime **facts**
   (is-git-repo, role, model, OS, permission mode…), **selects** which prompt fragments to
   include via **declarative conditions**, **orders** them, **renders** each through Layer 1,
   and **composes** the final system prompt that becomes `--append-system-prompt-file`.

The split is the Single Responsibility line: Layer 1 = *render a template*; Layer 2 =
*decide which templates make up this session's system prompt*. Layer 1 is usable standalone
(it subsumes today's `manager/prompts/` action templates); Layer 2 depends on Layer 1, never
the reverse.

A key Eos-specific simplification falls out of the architecture: because the system prompt is
fixed at launch by a PTY flag (`--append-system-prompt-file`), **DPI runs exactly once per
session**. We do not need pi-max's per-turn recomposition, L4 reminders, or fingerprint
caching. That machinery is deliberately out of scope (§9).

---

## 1. Background & research synthesis

### 1.1 The seed: `pi-max` DPS

The user's `pi-max` project already implements a "Dynamic Prompt System". What it gets right,
and what we keep:

- **`.prompt.md` files = YAML frontmatter + markdown body.** Path-derived ids
  (`system/coding-agent.prompt.md` → `system/coding-agent`). Layered sources
  (built-in → `~/.pi/...` → project `.pi/prompts/`) with shadowing.
- **GLOBAL vs LOCAL variables.** Globals auto-filled from session state / providers; locals
  passed per `render()` call and override. Definitions carry `type`, `required`, `default`.
- **Declarative conditions** as a discriminated union (`tool_active`, `file_exists`,
  `turn_count_above`, …) with `all` / `any` / `not` combinators, **compiled once, evaluated
  many**.
- **Layer model** L0–L4 (Core / Environment / Tool / Custom / Reminder) + priority within a
  layer for deterministic ordering.
- Clean module split: a `prompt` package (parser + registry + renderer) **independent** from
  the `dps` feature (state + conditions + composition).

What we drop or fix (its documented weaknesses):

- **No fingerprint cache, no L4/per-turn loop** — Eos sets the prompt once at launch (§9).
- **Variable providers were re-run every composition with no memoization** → we make
  providers lazy + memoized within one assembly.
- **Conditions were a hard-coded `switch`** with no clean extension point → we make the
  operator set a small closed Zod schema and push *richness* into derived facts, not into the
  expression grammar.
- **Circular `includes` could hang** and token budgeting was naive → we keep composition
  flat (no recursive partials in v1) and skip token-budget trimming (a launch-time prompt is
  authored, not auto-trimmed).

### 1.2 The reference: Claude Code's own system prompt

Claude Code assembles its system prompt from ~116 named fragments + ~97 injected reminders,
each a small file with a metadata header. The patterns worth stealing verbatim:

- **Fragment-per-concern, not one mega-string.** Each fragment owns one concern so
  include/exclude is a clean binary decision.
- **Every fragment declares its `variables:` manifest** — an audit trail and a validation
  hook (we can assert every placeholder has a binding before assembly).
- **Two levels of conditioning:** coarse (whole-fragment inclusion) + fine (inline
  `${cond ? a : b}` for tiny variants within one fragment). Don't force one-word variations
  up to the fragment level.
- **Fail safe on unknown facts.** The `powershell-edition-unknown` fragment assumes the
  *more restrictive* dialect. Unknown → conservative branch, never "inject nothing".
- **Never hard-code remappable names.** Tool names, dirs, model ids all flow through
  variables so prose can't desync when something is renamed/disabled.
- **Runtime facts go in a fenced, tagged block** (`<env>…</env>`, `gitStatus:`) separate from
  behavioral prose, explicitly labeled "snapshot … will not update".
- **Make overrides explicit.** Focus-mode literally says it "overrides earlier guidance about
  short updates". When two included fragments conflict, the later/more-specific one *names*
  what it supersedes rather than silently coexisting.

### 1.3 The integration target: Eos today

Three prompt-ish mechanisms exist; the new system relates to each:

| Mechanism | Storage | Templating | Resolved | Fate under this design |
|---|---|---|---|---|
| **System prompts** | `manager/{orchestrator,worker,git-agent}-prompt.md` | none (static) + boot-time worktree env append | daemon route picks file by role; worker boot appends env | **Becomes DPI fragments.** Role-ternary replaced by fact-based selection; the worktree env block becomes an `env/worktree` fragment. |
| **Action templates** | `manager/prompts/*.md` | `$1` positional | `PromptTemplateService.render()` daemon-side | **Subsumed by Layer 1** (named vars instead of positional). |
| **User templates** | `~/.eos/templates/*.md` | `{{label}}` tab-stops | **client-side** (composer UX, human fills tab-stops) | **Stays separate** — different concern (interactive composer insertion), not programmatic assembly. May share file/format conventions only. |

Confirmed integration facts (read first-hand):

- The launch flag is set in `spawner/claude-args.ts:77`:
  `if (opts.systemPromptFile) args.push("--append-system-prompt-file", opts.systemPromptFile)`.
- Role selection today lives in `manager/routes/workers.ts` (~L100):
  `isGitAgent ? gitAgentPromptFile : parentId ? workerPromptFile : undefined`.
- Worker-boot env synthesis is `spawner/prompt-context.ts → buildSystemPromptFile()` — reads
  the static file, appends a generated `# Environment` section for worktree workers, writes
  `${tmpDir}/system-prompt.md`, returns the path.
- Facts already computed daemon-side at spawn: `role`, `parentId`, `model`, `effort`,
  `permissionMode`, `isGitRepo()`, generated `branch`, precomputed `worktreeDir`, `isAttached`
  (`workspaceOf`), `persistent`, plus `process.platform`. There is a `GitInfo` **port** already
  in `core/src/ports/GitInfo.ts`.
- Non-regenerable user data is declared once in `manager/shared/user-data.ts`
  (`USER_DATA_ENTRIES`). A new `~/.eos/prompts/` dir **must** be added there.
- Core layout is flat: `core/src/ports/*.ts`, `core/src/services/*.ts`,
  `core/src/domain/*.ts`, `core/src/use-cases/*.ts`. New code must land in those buckets (the
  lint allowlist bans novel top-level dirs under `core/src/`).

---

## 2. Goals, non-goals, constraints

**Goals**

- G1. One centralized place to author and fetch prompts, reusable across the daemon
  (system prompts, action prompts, future MCP-tool prompts).
- G2. Variables with global auto-fill + per-call override, declared and validated.
- G3. Session-start conditional assembly: include git guidance only in git repos, role
  guidance per role, etc. — driven by data, not branching code.
- G4. Fits Eos Clean Architecture: `contracts → core → infra → entrypoints`, ports in core,
  adapters in infra, pure core (no Node imports, `Clock` not `Date.now`).
- G5. Authoring-time safety: validate frontmatter, manifests, and conditions; a bad prompt
  file degrades gracefully, never crashes the daemon.

**Non-goals (v1)**

- N1. Mid-session / per-turn re-injection (`<system-reminder>` deltas). The prompt is fixed at
  launch. (Future: §9.)
- N2. Token-budget auto-trimming. Launch prompts are authored, not machine-trimmed.
- N3. Replacing the user-facing composer templates (`~/.eos/templates`, `{{label}}`
  tab-stops) — different concern.
- N4. A general expression language in conditions. Keep a tiny closed operator set; push
  complex logic into derived facts.

**Hard constraints**

- C1. Core stays pure. File reads, `git`, `process.platform` live behind ports/adapters.
- C2. Schemas are Zod in `contracts/`, the single source of truth for IPC + on-disk shapes.
- C3. Config is frozen after load; a prompt store is read from disk + watched, not stuffed
  into frozen config.

---

## 3. Architecture overview

```
                       ┌──────────────────────────────────────────────────────────┐
   session start  ───▶ │ Layer 2 — DPI            AssembleSystemPrompt (use-case)   │
   (spawn facts)       │                                                            │
                       │   gather facts ─▶ select (conditions) ─▶ order ─▶          │
                       │        ▲                                       render each │
                       │        │ FactProvider[]                         │ compose  │
                       │        │ (git, env, session, mcp)               ▼          │
                       │   ConditionEvaluator · FragmentSelector · PromptComposer   │
                       └───────────────────────────────┬────────────────────────────┘
                                                       │ renders via (depends on)
                                                       ▼
                       ┌──────────────────────────────────────────────────────────┐
   "give me prompt X"  │ Layer 1 — Prompt System   PromptService.render(id, locals?)│
   (anywhere)     ───▶ │                                                            │
                       │   PromptRegistry ─ TemplateParser ─ TemplateRenderer       │
                       │        ▲                              ▲                    │
                       │        │ PromptSource                 │ VariableResolver   │
                       │        │ (files, watched)             │  ▲ VariableProvider[]│
                       └────────┴──────────────────────────────┴──┴─────────────────┘
```

- **Dependency direction is strictly downward.** Layer 1 has no idea Layer 2 exists. A
  fragment file is just a Layer-1 prompt that happens to carry an extra `dpi:` block in its
  frontmatter; Layer 1 ignores `dpi:`, Layer 2 reads only it. (Interface Segregation.)
- **Everything I/O-ish is a port.** `PromptSource` (where templates live), `VariableProvider`
  (where dynamic values come from), `FactProvider` (where runtime facts come from). Core
  depends on the interfaces; infra implements them; `manager/container.ts` wires them.
  (Dependency Inversion.)
- **Pure services are trivially testable**: parser, renderer, resolver, evaluator, selector,
  composer take data in and return data out — no clock, no fs, no git.

Module placement (respecting the flat core layout + lint allowlist):

```
contracts/src/prompt.ts        — PromptFrontmatter, VariableDef, Condition, DpiMeta, Facts (Zod)
core/src/domain/prompt.ts      — value objects: ParsedPrompt, Fragment, FactSet, RenderResult
core/src/ports/PromptSource.ts
core/src/ports/VariableProvider.ts
core/src/ports/FactProvider.ts
core/src/services/TemplateParser.ts       (pure)
core/src/services/TemplateRenderer.ts     (pure)
core/src/services/VariableResolver.ts     (pure logic; takes provider outputs)
core/src/services/PromptRegistry.ts       (uses PromptSource)
core/src/services/ConditionEvaluator.ts   (pure)
core/src/services/FragmentSelector.ts     (pure)
core/src/services/PromptComposer.ts       (pure)
core/src/use-cases/AssembleSystemPrompt.ts
infra/src/prompt/FilePromptSource.ts      (chokidar-watched dir → raw prompts)
infra/src/prompt/providers/*.ts           (Clock/Env/Git/Session/Mcp providers)
manager/container.ts                      — wiring
manager/routes/prompts.ts                 — introspection + assembly preview (debug)
```

---

## 4. Layer 1 — the Prompt System

### 4.1 On-disk format

A prompt is a markdown file with YAML frontmatter. Id is path-derived
(`tone/concise.prompt.md` → `tone/concise`).

```markdown
---
id: tone/concise                       # optional; defaults to path-derived
description: Concise end-of-turn summary rule
variables:
  - { name: agentName, type: string, required: true }
  - { name: maxLines, type: number, default: 2000 }
---
You are {{agentName}}. Keep summaries under {{maxLines}} lines.
{{#if verbose}}Explain your reasoning briefly before acting.{{/if}}
```

**Sources & precedence** (a `CompositePromptSource` over ordered sub-sources; later wins):

1. Built-in: shipped in the repo (`manager/prompts-lib/` — the renamed, expanded home of
   today's `manager/prompts/`).
2. User/global: `~/.eos/prompts/` (added to `USER_DATA_ENTRIES`).

A project tier (`<cwd>/.eos/prompts/`) is a clean future extension but **not** in v1
(Simplicity First — no consumer needs it yet).

### 4.2 The templating engine (deliberately tiny)

Grammar — interpolation + a single conditional construct. No loops, no equality operators, no
nested expressions:

| Token | Meaning |
|---|---|
| `{{ path }}` | interpolate; `path` may be dotted (`git.branch`); missing → `""` (+warning) |
| `{{#if path}} … {{/if}}` | render body iff `path` resolves truthy |
| `{{#unless path}} … {{/unless}}` | render body iff `path` resolves falsy |

"Truthy" excludes `false, 0, "", null, undefined, []`. No HTML escaping (prompts are plain
text/markdown, not web output).

This is an **Interpreter** over a small grammar: `tokenize → parse to AST (Composite:
Text | Interp | Cond) → evaluate(ast, scope)`. ~150 lines, fully pure, exhaustively unit-
testable. Lists (recent commits, additional dirs) are **pre-formatted by a variable provider
into a string** rather than looped in-template — this keeps the engine minimal and matches
Claude's `${addedLines.join('\n')}` approach (the join happens in code).

Rationale for including `{{#if}}` at all: Claude's "two-level conditioning" lesson — tiny
one-line variants shouldn't require splitting into two near-identical fragments + a selection
condition. Everything bigger than a sentence belongs at the fragment level (Layer 2).

### 4.3 The variable model (global vs local)

This is the user's core requirement: *"give me prompt X"* (globals auto-fill) **or** *"give me
prompt X with var = value"* (locals win). Resolution precedence, highest first:

```
1. local value      (passed to render(id, locals))
2. global value      (GlobalVariableScope — set explicitly, or supplied by a provider)
3. definition default (variables[].default)
4. unresolved:
     required → throw MissingVariableError(id, name)
     optional → "" (rendered empty)
```

**`GlobalVariableScope`** is a small registry the daemon populates once (e.g. `agentName`,
`os`) plus **lazy, memoized provider-backed keys**. A `VariableProvider` declares which keys
it can supply and is invoked **only if a rendered template actually references one** — and its
result is cached for the duration of one resolution. This directly fixes pi-max's "providers
re-run every time" weakness and means *a non-git prompt never pays for a `git` call*.

```ts
// core/src/ports/VariableProvider.ts
export interface VariableProvider {
  readonly keys: readonly string[];                 // e.g. ["git.branch", "git.recentCommits"]
  provide(ctx: VariableContext): Record<string, VariableValue>;
}
```

```ts
// Layer 1 public facade — the two call shapes the user asked for
promptService.render("tone/concise", { agentName: "Eos" });  // local override
promptService.render("env/header");                          // globals auto-filled
```

### 4.4 Components & responsibilities

| Component | Layer | Responsibility | Depends on |
|---|---|---|---|
| `TemplateParser` | core/service (pure) | raw md → `{ frontmatter, body }`; validate frontmatter via Zod; check every `{{var}}` is declared (warn) | — |
| `TemplateRenderer` | core/service (pure) | AST eval of body against a resolved scope | — |
| `VariableResolver` | core/service (pure) | merge local + global + provider outputs + defaults; enforce `required` | (provider *outputs*, passed in) |
| `PromptRegistry` | core/service | load (via `PromptSource`) + parse + cache parsed templates; expose `get(id)`, `list()` | `PromptSource` |
| `PromptService` | core/service (Facade) | `render(id, locals?)`: registry.get → resolve → renderer.render | `PromptRegistry`, `VariableResolver` |
| `FilePromptSource` | infra | read prompt dirs, chokidar-watch, invalidate registry cache on change | fs, chokidar |
| `*VariableProvider` | infra | supply dynamic globals (date via `Clock`, git facts via `GitInfo`, env) | Clock/GitInfo/etc. |

Caching: parsed templates are cached in `PromptRegistry`; a chokidar event from
`FilePromptSource` invalidates the changed id (edits apply without a daemon restart — matching
the current `PromptTemplateService` behavior).

### 4.5 Patterns used (Layer 1)

- **Facade** — `PromptService` (one method hides registry + resolver + renderer).
- **Strategy** — `PromptSource`, `VariableProvider` (pluggable storage / value sources).
- **Registry** — `PromptRegistry`.
- **Interpreter + Composite** — the `{{ }}` engine and its AST.
- **Memoization** — lazy provider-backed globals.

---

## 5. Layer 2 — Dynamic Prompt Injection

### 5.1 A fragment = a Layer-1 prompt + a `dpi:` block

DPI introduces **no new file type**. A fragment is a normal prompt whose frontmatter carries
an optional `dpi:` block. Layer 1 ignores it; Layer 2 reads only it.

```markdown
---
id: env/git-status
description: Git status block, only in repos
variables:
  - { name: branch,        type: string, required: true }
  - { name: mainBranch,    type: string, default: main }
  - { name: recentCommits, type: string, default: "" }
dpi:
  layer: environment            # core | environment | role | tool | safety | custom
  priority: 20                  # lower = earlier within a layer
  when: { fact: isGitRepo, eq: true }
---
gitStatus: This is the git status at the start of the conversation. It will not update.
Current branch: {{branch}}
Main branch (you will usually use this for PRs): {{mainBranch}}
{{#if recentCommits}}
Recent commits:
{{recentCommits}}
{{/if}}
```

### 5.2 Facts — the typed runtime snapshot

A flat, typed, **snapshotted-once** bag of session truths. Gathered by merging `FactProvider`
outputs at session start.

```ts
// contracts/src/prompt.ts (sketch)
export const SessionFactsSchema = z.object({
  role:           z.enum(["orchestrator", "worker", "git"]),
  isSubagent:     z.boolean(),      // parentId != null
  isGitRepo:      z.boolean(),
  isWorktree:     z.boolean(),
  isAttached:     z.boolean(),      // workspaceOf — shared worktree
  model:          z.string(),
  effort:         z.string().nullable(),
  permissionMode: z.string(),
  os:             z.string(),       // process.platform
  shell:          z.string(),
  hasMcp:         z.boolean(),
}).passthrough();                   // open for new facts without a breaking change
```

```ts
// core/src/ports/FactProvider.ts
export interface FactProvider {
  gather(ctx: SessionSpawnContext): Partial<SessionFacts>;   // may be async in infra
}
```

Providers (infra): `EnvironmentFactProvider` (os/shell), `GitFactProvider` (built on the
existing `GitInfo` port: isGitRepo/branch/isWorktree), `SessionFactProvider`
(role/model/effort/permissionMode/isSubagent/isAttached from the spawn spec), `McpFactProvider`
(hasMcp). **Fail safe** (Claude lesson): a provider that can't determine a fact returns the
conservative default (e.g. `isGitRepo: false`) so unknown → the safe branch, never a crash.

Facts feed two consumers from one source: (a) condition evaluation (this section) and (b) the
global variable scope (a fact can be interpolated by a fragment, e.g. `{{branch}}`).

### 5.3 Conditions — declarative, composable, validated

A small **closed** operator set, expressed as data (so conditions live in frontmatter, are
Zod-validatable, serializable, and safe — no code eval). This is the **Specification** pattern
realized declaratively, evaluated by an **Interpreter** over the condition tree.

```ts
// contracts/src/prompt.ts (sketch — recursive)
const Leaf = z.object({ fact: z.string() }).and(z.union([
  z.object({ eq:     z.unknown() }),
  z.object({ ne:     z.unknown() }),
  z.object({ in:     z.array(z.unknown()) }),
  z.object({ exists: z.boolean() }),
  z.object({ truthy: z.boolean() }),
]));
export const ConditionSchema: z.ZodType = z.lazy(() => z.union([
  Leaf,
  z.object({ all: z.array(ConditionSchema) }),
  z.object({ any: z.array(ConditionSchema) }),
  z.object({ not: ConditionSchema }),
]));
```

Examples:

```yaml
when: { fact: isGitRepo, eq: true }                      # git block only in repos
when: { all: [ { fact: role, eq: worker },               # worker-only handover rule…
               { fact: isWorktree, eq: true } ] }         # …in a worktree
when: { fact: model, in: [opus, sonnet] }                # skip on haiku
when: { not: { fact: isSubagent, eq: true } }            # orchestrator/top-level only
```

A fragment with **no `when`** is unconditional (always included if its layer is active). The
**escape hatch** for logic the grammar can't express: compute a *derived fact* in a
`FactProvider` (e.g. `needsGitGuidance`) and condition on that. Complexity goes into typed
fact computation, never into an ad-hoc expression language (N4).

### 5.4 The assembly pipeline

`AssembleSystemPrompt` is the orchestrating use-case — a clean **Pipeline** of single-purpose
pure steps:

```
execute(spawnCtx) -> { text, path, activeFragmentIds }:
  1. facts    = factGatherer.gather(spawnCtx)              // snapshot, merge providers, fail-safe
  2. frags    = registry.fragments()                       // all prompts that carry dpi:
  3. selected = frags.filter(f => evaluator.matches(f.dpi.when, facts))
  4. ordered  = selector.order(selected)                   // by layer rank, then priority
  5. globals  = scope.withFacts(facts)                     // facts + providers as variables
  6. rendered = ordered.map(f => promptService.render(f.id, {}, globals))
  7. text     = composer.compose(rendered, facts)          // env block + joined prose
  8. write text to ${tmpDir}/system-prompt.md → path
```

Each of steps 3/4/6/7 is a pure function of its inputs. Only step 1 (facts) and step 8 (write)
touch the outside world, and both are behind ports/adapters.

**Layer ordering** (Strategy; default rank): `core → environment → role → tool → safety →
custom`. Mirrors Claude's flow (identity → environment → tone → task → mode/safety) and
pi-max's L0–L3. Within a layer, ascending `priority`.

### 5.5 Composition

`PromptComposer` joins rendered fragments deterministically and, per Claude's lesson, emits the
**volatile facts as a fenced, tagged block separate from behavioral prose**:

```
<behavioral fragments, core→…→custom, joined by blank lines>

Here is useful information about the environment you are running in:
<env>
Working directory: {{cwd}}
Is directory a git repo: {{isGitRepo ? Yes : No}}
Platform: {{os}}
...
</env>
```

The `env` block is itself a fragment (`env/runtime`, layer `environment`) so it's authored, not
hard-coded — but it's the canonical place volatile facts land. **Explicit overrides** (Claude):
a fragment may declare `dpi.overrides: [id…]`; when it is selected, the named fragments are
dropped from the set before ordering — so a more-specific rule cleanly supersedes a general one
instead of both appearing. (Optional; ship if/when a real conflict appears.)

### 5.6 Patterns used (Layer 2)

- **Pipeline** — the assemble steps.
- **Specification + Interpreter** — composable conditions evaluated over facts.
- **Strategy** — `FactProvider`, layer-ordering policy.
- **Builder** — `PromptComposer` assembles the final artifact.
- **Snapshot** — facts captured once at session start.

---

## 6. Integration with Eos

### 6.1 One assembly path, in the daemon

Today prompt resolution is split: the route picks a file by role, and `prompt-context.ts`
appends env at worker boot. DPI **unifies both into the daemon** so there is one centralized
assembler (the user's "merkezi" requirement):

- **Replace** the role-ternary in `manager/routes/workers.ts` with a call to the
  `AssembleSystemPrompt` use-case (wired in `container.ts`). It receives the spawn spec, gathers
  facts, and returns assembled **text**.
- **Migrate** `spawner/prompt-context.ts`'s worktree `# Environment` block into DPI fragments
  (`env/worktree`, `env/worktree-shared`, conditioned on `isWorktree` / `isAttached`). The
  branch/dir/repoRoot values become variables filled by the `GitFactProvider`. `buildSystemPromptFile`
  shrinks to "write the already-assembled text to `${tmpDir}/system-prompt.md`" — or is removed
  if the daemon writes the file and passes the path.
- The assembled prompt reaches the worker through the **existing** `systemPromptFile` arg →
  `--append-system-prompt-file` (`claude-args.ts:77`). No new transport.

Because every needed fact is already known daemon-side (role, parentId, model, effort,
permissionMode, isGitRepo, generated branch, precomputed worktreeDir, isAttached, platform),
assembling in the daemon is sound. Orchestrators — which currently get **no** system prompt —
now get their own fragment set (selected by `role: orchestrator`), so the brittle
`isGitAgent ? … : parentId ? … : undefined` selection is gone, replaced by data.

### 6.2 Registration & config

- Add `"prompts"` to `USER_DATA_ENTRIES` in `manager/shared/user-data.ts` so `~/.eos/prompts/`
  is backed up by `StartupBackupService` and respected by home migrations (per CLAUDE.md, a
  user-data dir outside this list "lives outside every safety net").
- Built-in prompt dir path added to `manager/shared/config.ts` `paths` (alongside the existing
  `promptsDir`).
- Wire the new ports in `container.ts`: `FilePromptSource(builtinDir, userDir)` →
  `PromptRegistry` → `PromptService`; the `FactProvider[]`; `AssembleSystemPrompt`.

### 6.3 Subsuming action templates (DRY)

`manager/prompts/{commit,create-pr,verify,rebase}.md` move under the built-in source and switch
`$1` → named vars (`{{push}}`). `worker-actions.ts` calls `promptService.render("commit",
{ push: "true" })` instead of `PromptTemplateService.render("commit.md", ["true"])`. The 24-line
`PromptTemplateService` is deleted once callers migrate. (Action templates have no `dpi:` block,
so they're pure Layer-1 consumers — proof the layering holds.)

### 6.4 Introspection & preview (high value, low cost)

A debug surface that both pi-max (`/dps-log`) and the Claude-prompts repo's very existence prove
people want — *"what prompt did this session actually get, and why?"*:

- `GET /api/prompts` — list catalog (id, description, layer, variables, has-conditions).
- `POST /api/prompts/preview` — body = a `SessionFacts` object; returns the assembled text +
  `activeFragmentIds` + per-fragment include/exclude reasons. Backs a future Workflows-UI panel
  and is the authoring feedback loop.
- CLI `eos prompts validate` — parse all sources, report frontmatter/manifest/condition errors;
  fail-fast for authoring. (Runtime stays graceful: a broken file is skipped + logged, never
  fatal — G5.)

---

## 7. SOLID & pattern mapping

| Principle | How it shows up |
|---|---|
| **S**RP | Layer 1 renders; Layer 2 selects/orders/composes. Within each, parser ≠ renderer ≠ resolver ≠ evaluator ≠ selector ≠ composer — each one reason to change. |
| **O**CP | New prompt = drop a file (no code). New fact = add a `FactProvider` + schema field. New variable source = add a `VariableProvider`. New source tier = add a sub-source. No edits to the engine. |
| **L**SP | Any `PromptSource` / `VariableProvider` / `FactProvider` is substitutable — tests inject in-memory fakes for the file/git/clock ones. |
| **I**SP | Layer 1 depends on `PromptSource` (not "the file system"); it never sees `dpi:` or facts. DPI never sees the renderer's internals. Each port is one narrow capability. |
| **D**IP | Core depends on port interfaces; infra implements; `container.ts` injects. No `fs`/`git`/`Date.now` in core. |

| Pattern | Where |
|---|---|
| Facade | `PromptService` |
| Registry | `PromptRegistry` |
| Strategy | `PromptSource`, `VariableProvider`, `FactProvider`, layer-ordering |
| Interpreter + Composite | `{{ }}` template engine; condition tree |
| Specification | composable `all`/`any`/`not` conditions |
| Pipeline | `AssembleSystemPrompt` |
| Builder | `PromptComposer` |
| Snapshot / Memoization | facts captured once; lazy provider globals |

---

## 8. Worked examples

**(a) Non-git project, top-level orchestrator (opus).**
Facts: `{ role: orchestrator, isSubagent:false, isGitRepo:false, isWorktree:false, model:opus,
permissionMode:default, os:darwin }`.
Selected: `core/*` (unconditional), `env/runtime`, `role/orchestrator`. **Excluded:**
`env/git-status` (`isGitRepo eq true` ✗), `env/worktree` (`isWorktree` ✗), any `role/worker`,
`role/git`. → No git prose appears at all. This is the user's headline example, achieved by one
condition, zero branching code.

**(b) Worker in an isolated worktree (sonnet).**
Facts: `{ role:worker, isSubagent:true, isGitRepo:true, isWorktree:true, isAttached:false,
model:sonnet, permissionMode:bypassPermissions }`.
Selected adds `env/git-status` (branch/commits via `GitFactProvider`), `env/worktree` (the
migrated isolation contract + Handover line), `role/worker`. Ordering: core → env/runtime →
env/git-status → env/worktree → role/worker.

**(c) Attached worker (shared worktree).**
`isAttached:true` selects `env/worktree-shared` and (via `overrides:`) drops `env/worktree`, so
the "shared workspace rules" replace the "isolated" rules cleanly — exactly today's
`buildSystemPromptFile` branch, now data-driven.

---

## 9. Deliberately out of scope (and why)

- **Per-turn recomposition / L4 reminders / fingerprint cache (pi-max has these).** Eos's
  system prompt is a launch flag; it cannot change mid-session. Assembly runs **once**. Dropping
  this removes pi-max's most complex subsystem. If mid-session nudges are ever wanted, they'd
  ride the existing PTY message channel as steering messages — a separate feature, not the
  system prompt.
- **Recursive partials / `extends` / `includes`.** Composition is flat at the fragment level
  (Layer 2 already *is* composition). This sidesteps pi-max's circular-include hang and keeps the
  renderer tiny. Shared snippets, if needed, become their own fragments.
- **Loops / equality / arbitrary expressions in templates and conditions.** Lists are
  provider-formatted strings; rich logic is a derived fact. (N4, Simplicity First.)
- **Token-budget trimming.** Launch prompts are authored to fit.
- **Project-tier prompt source.** Real but unneeded now; clean to add later (OCP).

---

## 10. Phased roadmap

Built bottom-up, matching the user's stated order ("prompt sistemi önce, sonra DPI"):

1. **Phase 1 — Prompt System (Layer 1).** Contracts schemas; `TemplateParser`,
   `TemplateRenderer`, `VariableResolver`, `PromptRegistry`, `PromptService`; `FilePromptSource`
   + chokidar; Clock/Env variable providers. Unit tests on the pure core. *Verify:* render a
   template with locals + global auto-fill; missing-required throws.
2. **Phase 2 — Subsume action templates.** Move `manager/prompts/*` to built-in source, `$1` →
   named vars, repoint `worker-actions.ts`, delete `PromptTemplateService`. *Verify:* `/commit`
   etc. still produce identical prompts (golden test).
3. **Phase 3 — DPI (Layer 2).** `FactProvider`s + `GitFactProvider` on `GitInfo`; condition
   schema + `ConditionEvaluator`; `FragmentSelector`; `PromptComposer`; `AssembleSystemPrompt`.
   *Verify:* golden tests — facts X → assembled prompt Y (the §8 cases).
4. **Phase 4 — Cut over spawn.** Author `core/*`, `role/*`, `env/*` fragments from today's
   `{orchestrator,worker,git-agent}-prompt.md`; migrate the worktree env block; replace the
   route role-ternary; route the assembled text to `--append-system-prompt-file`. *Verify:* spawn
   each role in a throwaway `EOS_HOME=$(mktemp -d)` daemon; diff assembled vs current prompts.
5. **Phase 5 — Introspection.** `GET /api/prompts`, `POST /api/prompts/preview`,
   `eos prompts validate`.

Each phase is independently shippable; Layer 1 delivers value (centralized prompts + DRY action
templates) before any DPI exists.

---

## 11. Key decisions & alternatives

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Two layers vs one engine | **Two** (render vs assemble) | One DPS doing everything | SRP; Layer 1 reused standalone (action templates); matches pi-max's own split. |
| Conditions: data vs code | **Declarative data** | Registered code predicates | Zod-validatable, serializable, safe, lives in frontmatter, introspectable. Richness → derived facts. |
| Where to assemble | **Daemon** (one path) | Keep daemon route + worker-boot split | Centralization (user's goal); all facts known daemon-side; kills the split-brain. |
| Template control flow | **Interp + `{{#if}}` only** | Full Handlebars (loops, eq) | Claude's two-level lesson covers tiny variants; everything else is a fragment or a fact. Tiny, testable engine. |
| Assembly cadence | **Once at session start** | Per-turn recompose (pi-max) | Launch flag is immutable mid-session; removes the most complex subsystem. |
| Action templates | **Subsume into Layer 1** | Leave `PromptTemplateService` | DRY; one templating engine; named > positional vars. |
| User composer templates | **Leave separate** | Merge into the catalog | Different concern (interactive client-side tab-stops, not server assembly). |

---

## 12. Risks & mitigations

- **Behavioral drift when splitting monolith prompts into fragments.** → Golden-file diff per
  role in Phase 4; cut over only when assembled == current (modulo intended fact-driven
  differences).
- **A broken prompt file at runtime.** → Source skips + logs the bad id; daemon never crashes
  (G5). `eos prompts validate` catches it at authoring time.
- **Fact desync (a fact the code computes but no provider exposes).** → `SessionFacts` is the
  single Zod source; providers return `Partial<SessionFacts>`; a preview endpoint shows the
  exact fact bag a session saw.
- **Two `{{ }}` dialects** (new engine vs the user-template `{{label}}` tab-stops). → They never
  meet: tab-stops are client-side composer UX; the engine is daemon-side. Documented in §1.3;
  no shared resolver.
- **Provider cost** (e.g. git on every spawn). → Lazy + memoized; a prompt that references no
  git var triggers no git call.
```
