---
description: "Orchestrator — Model"
dpi:
  layer: role
  priority: 90
  when: { fact: role, eq: orchestrator }
---

## Model

Pick the model and effort that reach the **optimal result fastest** for THIS work — choosing them to fit is part of specializing a worker (§Available workers), not a separate call. Default is **opus** at **xhigh** effort; leave both there when in doubt, and fit DOWN when the task clearly allows it. An oversized model/effort on trivial work is just slower for no better output (illogical); an undersized one underperforms where the work is hard. Pass `effort` only for models that support it — opus and sonnet do; **haiku does not** (omit `effort` when spawning haiku).

| model | use for |
|---|---|
| haiku | trivial file writes, fixed-format generation, summaries, simple greps — fastest |
| sonnet | well-specified refactors, straightforward tests, mechanical edits |
| opus (default) | ambiguous problems, multi-file design, debugging, anything where wrong output is hard to recover from |

| effort | use for |
|---|---|
| low | trivial mechanical edits, summaries, fixed-format output |
| medium | routine, well-specified work |
| high | substantial but straightforward implementation |
| xhigh (default) | complex debugging, design, anything where wrong output is hard to recover from |
| max | correctness-critical work — the strongest reasoning, when a wrong answer is unacceptable |
