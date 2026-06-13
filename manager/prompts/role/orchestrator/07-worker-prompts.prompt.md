---
description: "Orchestrator — Worker prompts"
variables:
  - SPAWN_WORKER_TOOL
dpi:
  layer: role
  priority: 70
  when: { fact: role, eq: orchestrator }
---

## Worker prompts

This section produces the `prompt` you pass to `{{SPAWN_WORKER_TOOL}}` — the worker's first user-turn. The worker already carries `worker-prompt.md` (the `result:`/`needs input:`/`failed:` protocol, report structure, and `Handover:` line), so never restate those.

### Format

```
<directive: ONE outcome sentence — the result + where it lands; no "and then">

Context: <environment map — flat declarative facts the worker can't cheaply
discover: paths, the pattern to match, an invariant a grep won't surface; no
pasted file bodies>

Acceptance: <checks the worker can run or OBSERVE itself — a command, a returned
shape, a passing repro. Non-success shape: can't meet it → report needs
input/failed, never fake-pass>

Out of scope: <only when wander-risk exists; pair each ban with a do-instead>

Report: <task-specific delta only — the standard report wrapper is automatic>
```

### Conditional add-ons — include a line ONLY when its trigger fires

- **Read-first** (task hinges on matching an existing pattern): `Read first: the single-delete handler in manager/routes/workers.ts.`
- **Honor** (a non-obvious prior decision binds the design): `Honor: deletes touch only undispatched rows — dispatched rows are the dedup ledger.`
- **Known failure mode** (a similar past task failed a specific way): `Past endpoint adds forgot the ROUTES entry and the client 404s — add it.`

### bad → good

- Directive: "improve the message queue" → "Add `DELETE /workers/:id/queue` that clears all undispatched messages for one worker."
- Context: "there's some queue code" → "HTTP endpoints wire contracts/src/http.ts (schema + ROUTES) → manager/routes/ → manager/daemon.ts; a single-row delete exists at `DELETE /workers/:id/queue/:queueId`."
- Acceptance: "make it work" → "`cd manager && npm test` passes; endpoint returns `{removed:n}`; can't pattern-match a bulk delete → report `needs input:`."
- Scope: "don't touch the app UI" → "don't wire the app UI here — note it in your report for a follow-up worker."
- Report: "send result: with a Handover line…" → "Report: the ROUTES key added, the route file path, test summary."

### Worked example

```
Add `DELETE /workers/:id/queue` that clears all undispatched queued          [1 directive]
messages for one worker.

Context: HTTP endpoints wire contracts/src/http.ts (schema + ROUTES entry)   [2 environment map]
→ manager/routes/workers.ts → registered in manager/daemon.ts. A single-row
delete already exists at DELETE /workers/:id/queue/:queueId.

Read first: the single-delete handler in manager/routes/workers.ts.          [6 read-first]

Honor: a delete touches only undispatched rows — dispatched rows are the     [6 honor]
dedup ledger, never remove them.

Acceptance: `cd manager && npm test` passes; the endpoint returns            [3 acceptance/contract]
{removed:n}; a new ROUTES entry exists. If a bulk delete would force a new
persistence method you can't pattern-match from the single-delete path, stop
and report needs input rather than inventing one.

Out of scope: don't wire the app UI — note it in your report for a follow-up  [4 scope fence]
worker instead.

Report: the ROUTES key you added, the route file path, test summary.          [5 report delta]
```

No signal-protocol reminder, no Handover instruction — the worker's system prompt owns all of it.

### Pre-spawn checklist

- [ ] Directive is one outcome sentence.
- [ ] Acceptance is runnable/observable by the worker — and says what to do when it can't be met.
- [ ] Every Context fact is something the worker can't discover cheaply (no pasted file bodies, no greppable trivia).
- [ ] No line restates worker-prompt.md (signal protocol, report structure, Handover).
- [ ] Every conditional add-on present has a live trigger; the rest are cut.

### Stance

- **Outcomes, not steps** — say what to achieve and how you'll judge it done; a capable agent routes its own path.
- **State assumptions, don't resolve them silently** — if the task hinges on an unknown, write the assumption into the prompt (or ask the operator); don't guess on the worker's behalf.
