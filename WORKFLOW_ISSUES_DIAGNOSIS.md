# Workflow Correctness Bugs — Diagnosis + Fix Plan

Status: DIAGNOSIS ONLY. No code changed. Branch `feat/eos-workflow-system` (working tree clean).
Authoritative trace: `~/.eos/state.db` (`workflow_runs`, `workflow_steps`, `events`). Live daemon.

The operator report ("a Research Handoff orchestrator's workflows PASS without actually completing")
is **reproduced and root-caused**. It is not one bug but a *chain* of three independent defects that
compound; the recent turn-end-capture commit is the proximate trigger of the false PASS but not the
deepest defect.

---

## 0. The reproduction (the rows that prove it)

Orchestrator: `o-qjrra9` "Research Handoff Summary Orchestrator". It launched three runs of the same
two-step pipeline (researcher → summarizer, a `sequence`):

| run | def | run status | result_json (truncated) |
|---|---|---|---|
| `w-rom3j1vs` | research-then-summarize (v1)  | **failed** | `needs input: research findings are missing …` |
| `w-4bh1bfte` | research-then-summarize-v2     | **passed** ⛔ | `Verilen bulgular bölümü boş — özetlenecek … içerik bulunmuyor …` |
| `w-m1u6fad6` | research-then-summarize-v3     | **passed** ⛔ | `Özetlenecek herhangi bir araştırma bulgusu sağlanmadı … Lütfen … metni iletin.` |

The v2/v3 `result_json` is a **non-answer** — the summarizer telling the user "the findings section
is empty, please send me the text to summarize." That is a blocked/needs-input outcome, yet the run
is recorded `passed`. v1 is the *control*: the summarizer there happened to phrase the same blockage
as an explicit `needs input:` report, which classified correctly and failed the run.

Per-step rows (`workflow_steps`), the false passes:

```
run w-4bh1bfte:
  researcher  passed  worker w-ygr3tget  "result: Researched 'Claude AI…'; delivered 5 grounded facts…"
  summarizer  passed  worker w-7qd1tyjm  "Verilen bulgular bölümü boş — özetlenecek … içerik bulunmuyor…"   ⛔
  root(seq)   passed                     (= summarizer output)

run w-m1u6fad6:
  researcher  passed  worker w-35y3wf8y  "result: Researched \"Claude AI…\" — 5 grounded facts…"
  summarizer  passed  worker w-7dhbx7y6  "Özetlenecek herhangi bir araştırma bulgusu sağlanmadı…"          ⛔
  root(seq)   passed                     (= summarizer output)

run w-rom3j1vs (control — correct):
  researcher  passed  worker w-7023lxwz  "result: 4 key facts on Claude AI…"
  summarizer  failed  worker w-ue1iyhjx  "needs input: research findings are missing…"                     ✓
  root(seq)   failed
```

Two independent things are wrong here at once:
1. **Every researcher step lost its data**: its stored output is raw report *text*, never the
   `{facts:[…]}` / `{text:"…"}` object the orchestrator declared via `outputSchema`. So the
   summarizer's `{{nodes.researcher.output.facts}}` binding resolved to empty → it received empty
   findings → it produced a "nothing to summarize" non-answer. (Bugs B + C.)
2. **The non-answer was accepted as a PASS** instead of being failed. (Bug A — the reported symptom.)

The completion messages the orchestrator received confirm what was delivered upstream
(`events` for `o-qjrra9`): id `252656` = `[workflow w-4bh1bfte] completed (status: passed): "Verilen
bulgular bölümü boş …"`; id `252724` = `[workflow w-m1u6fad6] completed (status: passed): "Özetlenecek
… iletin."`.

---

## ISSUE A — A step PASSES on a non-report final message (`unknown` → `passed`) [the reported bug]

### Statement
A step-worker that ends its turn with an ordinary final assistant message that does **not** begin
with `result:` / `needs input:` / `failed:` is recorded `passed`, regardless of whether the message
is a real answer or a refusal/"can't do this" non-answer. The run then reports `passed`.

### Root cause (file:line)
Two collaborating lines, plus the recent capture commit that feeds them:

1. `core/src/domain/report-signal.ts:9-15` — `classifyReport(text)` returns `"unknown"` for any
   first line that is not one of the three tokens. The v2/v3 summarizers' first line was plain Turkish
   prose → `unknown`.
2. `core/src/workflow/executors/step.ts:31-33` —
   ```ts
   function signalStatus(signal): NodeResult["status"] {
     return signal === "failed" || signal === "needs-input" ? "failed" : "passed";
   }
   ```
   maps **everything that is not `failed`/`needs-input` — i.e. both `result` AND `unknown` — to
   `passed`. So an unrecognized final message passes.
3. `manager/services/WorkerSpawnAdapter.ts:295-306` (`onStateChange`, the recent turn-end-capture
   fix, commit `f1fbc77` / `327e0f0`) settles the join from the worker's **last assistant text**
   (`lastText`, fed by `container.ts:888-894` `noteAssistantText`) and classifies it with the same
   `classifyReport`. This is the path that turns a non-reporting worker's conversational final
   message into a step outcome at all.

The run then rolls up: `sequence.ts:18-22` returns the last child's status (summarizer = passed) →
`engine.ts:159-164` sets run status `passed` and `result_json` = that output.

### Evidence it is the IDLE-edge path (not an explicit report)
- No `worker_report` event exists for any v2/v3 step worker (`SELECT … WHERE type='worker_report' AND
  worker_id IN ('w-7qd1tyjm','w-7dhbx7y6',…)` → empty). Event count for each across the whole DB is 0.
- The v1 summarizer `w-ue1iyhjx` is the only summarizer with events: id `252605`
  `tool_result "Message delivered to orchestrator"` — it *did* call `send_message_to_parent` with a
  `needs input:` report → settled via `onReport` → `needs-input` → failed (control).
- Same model, same near-identical empty-input situation, opposite outcomes: v1 reported (→ fail),
  v2/v3 did not report and were captured by the IDLE edge (→ false pass). That difference is exactly
  the `onReport` vs `onStateChange` split.

### Is the recent turn-end-capture fix the cause?
**Partly — it is the trigger, not the deepest defect.** Before `f1fbc77`, a step-worker that never
called `send_message_to_parent` had no settle path and would have hung until `stepTimeoutMs` →
rejected → step `failed`. The capture fix correctly removes that hang, but it routes the worker's
arbitrary conversational final message through `classifyReport` → `unknown` → (via `signalStatus`)
`passed`. So the fix converted a *hang* into a *false pass*. The latent defect it exposed is the
`unknown → passed` mapping (item 2 above), which predates it. The correct response is **not to revert
the capture** (the hang was worse) but to make the captured message's classification honest (below).

### Severity
**Critical.** Silent false success is the worst failure class: the orchestrator relays `result:` to
the operator and continues as if the work completed. Any multi-step workflow whose step-workers don't
volunteer a token-prefixed report can pass on garbage.

### Clean / SOLID fix
The ambiguity is real: `classifyReport` cannot tell a genuine plain answer ("Eos is an orchestration
layer …") from a plain non-answer ("the findings are empty, please send them") — neither carries a
token. The current worker report-contract (`prompts/role/worker/09-reporting…`) governs the *explicit
report* (`send_message_to_parent`), **not** the conversational final message the IDLE edge grabs, so
we cannot assume the captured text is token-shaped. Two coordinated changes resolve it:

1. **Make the step's terminal message contract explicit (where the prompt is built).** In
   `core/src/workflow/executors/step.ts`, append a `STEP_REPORT_INSTRUCTION` to every step prompt
   (mirroring the existing `SCHEMA_INSTRUCTION` idiom at `step.ts:18-19`): *"End your final message
   with a first line that is exactly one of `result:` / `needs input:` / `failed:` <one-line headline>;
   it is how the workflow records this step's outcome."* This makes the IDLE-captured final message
   reliably token-shaped, so `classifyReport` becomes meaningful for the capture path.
2. **Treat `unknown` as `failed`, not `passed` (where status is decided).** Change `signalStatus`
   (`step.ts:31-33`) to:
   ```ts
   function signalStatus(signal): NodeResult["status"] {
     return signal === "result" ? "passed" : "failed";   // unknown/needs-input/failed → failed
   }
   ```
   A step that, despite the instruction, produced an unrecognized final message did **not**
   demonstrate success → fail loudly instead of passing on prose. This is the directive's suggested
   direction ("require a real result-shaped message; treat `unknown` as failed-not-passed") and keeps
   the change at the executor — the adapter stays a generic capture mechanism (SRP).

Why correct: success now requires a positive `result:` signal rather than the *absence* of a failure
signal — fail-closed, not fail-open. Legitimate plain answers stop being false-passed because the
instruction makes compliant workers emit `result:`; non-compliant ones fail loudly and surface the
real upstream breakage (Issues B/C) instead of masking it.

Optional hardening (note, not required for v1): on a no-token IDLE settle, the adapter could re-prompt
the worker once ("re-send your final line starting with result:/failed:/needs input:") before failing,
mirroring the schema re-prompt-once policy. Lower priority — adds a turn and complexity.

### Interaction with the capture fix
This *refines* `f1fbc77`/`327e0f0` rather than reverting it: the capture still settles non-reporting
workers (no hang), but only a `result:`-shaped final message yields `passed`. The empty-text guard at
`WorkerSpawnAdapter.ts:303` already prevents an empty final message from settling (→ timeout → fail),
so the only behavior change is "non-empty, non-result final message" flips from passed → failed.

---

## ISSUE B — `outputSchema` declared in an inline/declarative spec is silently ignored

### Statement
When a workflow is run via the `workflow` MCP tool with an inline spec (`mode:"run-inline"`, the only
way the orchestrator declares a step `outputSchema`), the schema is **completely inert**: no JSON is
extracted, no validation runs, no schema instruction is appended, and the step output is the raw
report *text* instead of the declared typed object. Downstream typed bindings then silently break.

### Root cause (file:line)
- The orchestrator declared a real schema on each researcher step (events `252561` / `252613` /
  `252662`, e.g. `outputSchema: {type:"object", properties:{facts:{type:"array",…}}, required:["facts"]}`).
- `contracts/src/workflow-node.ts:197` types it as `outputSchema: z.unknown().optional()` — it passes
  through as the raw JSON-Schema object. `WorkflowService.run` validates the spec
  (`WorkflowService.ts:67-68` `WorkflowDefinitionSchema.parse`) but there is **no** JSON-Schema→Zod
  conversion anywhere in the inline path (grep confirms none in `dsl.ts` / `WorkflowService.ts` /
  `tools/defs/workflow.ts`).
- `core/src/workflow/executors/step.ts:24-29,69` — `asZod(node.outputSchema)` only accepts an object
  with a `.safeParse` method (a live Zod schema). A plain JSON-Schema object has none → `asZod`
  returns `null` → `schema` is `null` → the executor takes the **no-schema** branch
  (`step.ts:73-80`): output = `outcome.reportText` (a string), no `SCHEMA_INSTRUCTION`, no extraction.
  The code comment at `step.ts:21-23` even documents this ("a serialized declarative spec carries a
  plain JSON-Schema object (not parseable in pure core), in which case validation is skipped and the
  raw text flows") — but nothing fails loudly on it.

### Evidence
- `workflow_steps` researcher rows store raw report text ("result: Researched …"), never a
  `{facts:[…]}` / `{text:"…"}` object. If the schema path had run, a parse failure would have made the
  step `failed` (`step.ts:101`); instead it `passed` with text — proving the no-schema branch ran.
- Only the **code-DSL** path (`dsl.ts`, a live Zod schema) ever satisfies `asZod`. The MCP tool the
  orchestrator uses cannot reach it.

### Severity
**High.** It is the upstream cause of the empty-findings data loss that, combined with Issue A,
produced the false passes. Independently, it means typed step I/O — a headline workflow feature — is a
silent no-op for every orchestrator-authored workflow.

### Clean / SOLID fix
Pick one of two stances; **(i) is recommended**:

(i) **Honor the declared JSON-Schema.** Provide a real validator for the declarative path. Keep core
pure: define the existing duck-typed `ZodLike { safeParse }` as the contract (already in `step.ts`),
and at the **manager composition root** wrap a JSON-Schema validator (e.g. a small
`JsonSchemaValidator` adapter, or `ajv`) into that `safeParse` shape, attaching it to the node when a
run is accepted (in `WorkflowService.run` / the inline-spec ingestion). The executor is unchanged — it
keeps calling `asZod(node.outputSchema)?.safeParse`; it just now receives a validator. This honors the
orchestrator's declared schema, makes `{{nodes.x.output.facts}}` resolve to a real object, and keeps
JSON-Schema parsing out of pure core (DIP — core depends on the `safeParse` abstraction, manager
supplies the concretion).

(ii) **Fail loudly if you won't honor it.** If declarative schema support is out of scope for now,
**reject** an inline spec that declares `outputSchema` at acceptance time
(`WorkflowService.run`, beside the existing `script`-node provenance check at `WorkflowService.ts:72`)
with a clear message ("inline-spec `outputSchema` is not supported; create the workflow and run it by
name"). This is strictly better than silently ignoring it — the orchestrator learns immediately
instead of shipping a broken data flow.

Recommended: **(i)** — it makes the feature actually work; (ii) only if schema support must be deferred.

### Interaction with the capture fix / Issue A
Independent of the capture fix. With B fixed, the researcher produces a real `{facts:[…]}` object, the
summarizer receives real findings, answers normally, and (with A's instruction) leads with `result:`
→ the run passes *legitimately*. With B unfixed but A fixed, the run *fails loudly* (correct — the data
flow is broken) instead of false-passing.

---

## ISSUE C — An unresolved/`undefined` binding renders to an empty string, silently

### Statement
A `{{nodes.<id>.output.<path>}}` reference that resolves to `undefined` (wrong path, missing field, or
a non-object output) is substituted with `""` in the step prompt, with no error, warning, or trace.
A typo or a shape mismatch silently feeds a step empty input.

### Root cause (file:line)
- `core/src/workflow/bindings.ts:91-100` — `stringifyBinding(undefined)` returns `""` (line 92).
- `core/src/workflow/bindings.ts:77-84` — `walkPath` returns `undefined` the moment it steps into a
  non-object (a string output, or a missing key). So `{{nodes.researcher.output.text}}` against a
  string output (Issue B made the output a string) → `walkPath(string,["text"])` → `undefined` → `""`.
  Same for `.facts` / `.facts.0` against a string.

### Evidence
- v3 spec (event `252662`): summarizer prompt `Summarize … :\n\n{{nodes.researcher.output.text}}\n\n…`.
  Researcher output was a string (Issue B) → binding → `""` → the summarizer literally saw "Summarize
  the following research findings:\n\n\n\nReturn only the Turkish summary." → "no findings, please send
  the text." The summarizer's own words in `result_json` confirm it received nothing.
- v1/v2 identical mechanism (`.facts` / `.facts.0` → `""`). The orchestrator's reasoning trace
  (`events` `252660`: "Array binding çalışmıyor … researcher'ın facts'i string olarak döndürmesi")
  shows it iterating blindly because the failure was silent.

### Severity
**Medium** (a force-multiplier for B; on its own it turns author mistakes into silent empty input).

### Clean / SOLID fix
Make broken data flow loud, not silent. Minimal, surgical option: in
`step.ts`/`bindings.ts`, when resolving a step prompt, detect any `{{…}}` token that resolved to
`undefined` and **fail the step** with a clear error ("binding `{{nodes.researcher.output.facts}}`
resolved to undefined — node `researcher` has no `facts` field"), rather than substituting `""`.
Implementation: add a strict resolve variant (e.g. `bindings.resolveStrict` or a flag on `resolve`)
that collects unresolved tokens; the step executor throws/returns `failed` if any are unresolved.
Keep `args`-optional templating tolerant if needed, but a `nodes.*` reference to a prior step's output
that doesn't exist is a hard authoring error and should not pass.

Why correct: data-flow errors surface at the first broken step instead of propagating empty strings
through the pipeline. SRP preserved — `BindingScope` stays the resolver; the *policy* ("undefined node
ref is fatal") lives in the step executor that owns prompt assembly.

### Interaction
Independent of A and B but complementary: even after B makes the object available, C protects against a
mistyped path. Lower priority than A/B; it is defense-in-depth.

---

## Latent risk (not triggered by these runs, but exposed by the capture design) — note only

**First-`IDLE`-wins may settle on a non-final turn.** `onStateChange`
(`WorkerSpawnAdapter.ts:295-306`) resolves on the **first** `WORKING→IDLE` edge with **any** non-empty
last assistant text. For a step-worker whose task legitimately spans more than one turn (e.g. it ends a
turn after a pause, a queued message, or an SDK turn boundary that is not task-completion), the first
turn-end would settle the step prematurely with a partial message. In these three runs this did **not**
happen — each summarizer produced its complete turn-1 answer and ended (verified: the captured text is
a coherent complete response, not a "let me start…" fragment) — so hypothesis (1) is **refuted for the
observed runs** but holds as a real design risk. With Issue A's fix (require `result:`), a premature
non-final turn-end would at least fail loudly (no token yet) rather than false-pass. A fuller guard
(only settle when the turn ended with a result-shaped message; otherwise keep waiting up to
`stepTimeoutMs`) would close it; recommend bundling this consideration into the Issue A fix.

**Hypothesis (3)** ("not all steps ran"): **refuted** — both steps ran in every run; the false pass is
purely the status mapping, not skipped steps.
**Hypothesis (4)** (schema → wrong status): **confirmed but via Issue B** — the schema is *ignored*,
not "no JSON → failed"; the lenient extractor never runs on inline specs.

---

## Dependency-ordered fix plan

1. **Issue A — honest step status (fixes the reported symptom).** `step.ts`: add
   `STEP_REPORT_INSTRUCTION` to every step prompt; change `signalStatus` so only `result` → `passed`
   (`unknown`/`needs-input`/`failed` → `failed`). Smallest change, highest leverage; stops the false
   pass immediately. Refines (does not revert) the recent capture commit.
   *Verify:* a step whose final message lacks a token → step `failed`, run `failed`; a step that ends
   with `result: …` → `passed`. Add/adjust the `WorkerSpawnAdapter` settle test + a step-executor test
   asserting `unknown → failed`.
2. **Issue B — honor (or explicitly reject) inline `outputSchema`.** Recommended: a manager-side
   JSON-Schema validator wrapped into the `safeParse` duck-type, attached at run acceptance; executor
   unchanged. Restores typed data flow so researcher→summarizer actually carries `{facts:[…]}`.
   *Verify:* a `run-inline` spec with `outputSchema` produces a parsed object as the step output; a
   downstream `{{nodes.x.output.facts}}` resolves to the array.
3. **Issue C — loud unresolved bindings.** Strict resolve for `nodes.*` refs in step prompts; an
   undefined reference fails the step with a precise message.
   *Verify:* a step referencing a missing field fails with the field named, instead of receiving `""`.

Order rationale: A removes the dangerous silent-success now (independent of B/C). B restores the
feature the runs actually needed. C is defense-in-depth that also depends on B's object being present
to be meaningful. A and B are independently shippable; do A first (it is the operator's reported bug).

Verification harness (per repo convention; do **not** `eos build`/`restart`): `cd manager && npm test`
(engine/adapter/rearm + core + spawner), `cd contracts && npm test`, `npm run lint` (dependency
direction + backend-kind guard).

---

## Uncertainties / what would further confirm

- **Step-worker prompt role.** The step nodes carried no `from:`, so step-workers used the default
  worker definition/role. I did not pin down exactly which DPI fragments a no-`from` workflow step
  worker receives (its events are not persisted — see below), so the *degree* to which the report
  contract reaches step-workers today is inferred from the prompt library, not read off a live spawn.
  This does not change Issue A's fix (which adds an explicit per-step instruction regardless), but a
  spawn-time prompt dump for a step worker would confirm the baseline.
- **Step-worker event opacity.** Step-worker `agent_event`s are not written to the `events` table
  (counts are 0 for every step worker except `w-ue1iyhjx`, whose 4 rows are its post-report
  continuation). The turn reconstruction therefore relies on `workflow_steps.output_json` +
  `worker:report` absence + the orchestrator's completion messages, which is sufficient to prove the
  settle path, but a future investigation would be easier if step-worker turns were traceable. Worth a
  separate ticket (observability), out of scope here.
- **Issue B stance** (honor vs reject inline schema) is a product call; (i) honor is recommended but
  (ii) reject-loudly is acceptable if declarative schema support is deferred.
