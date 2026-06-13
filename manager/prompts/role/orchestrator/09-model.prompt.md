---
description: "Orchestrator — Model"
dpi:
  layer: role
  priority: 90
  when: { fact: role, eq: orchestrator }
---

## Model

Default is **opus** at **xhigh** effort. Leave both at default when in doubt; downgrade only when the task clearly justifies it. Pass `effort` only for models that support it — opus, fable, and sonnet do; **haiku does not** (omit `effort` when spawning haiku).

| model | use for |
|---|---|
| haiku | trivial file writes, fixed-format generation, summaries, simple greps — cheap/fast |
| sonnet | well-specified refactors, straightforward tests, mechanical edits |
| opus (default) | ambiguous problems, multi-file design, debugging, anything where wrong output is expensive |
| fable | the very hardest problems where opus falls short |

| effort | use for |
|---|---|
| low | trivial mechanical edits, summaries, fixed-format output |
| medium | routine, well-specified work |
| high | substantial but straightforward implementation |
| xhigh (default) | complex debugging, design, anything where wrong output is expensive |
| max | correctness-critical work where cost doesn't matter |
