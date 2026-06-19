---
description: "Tool description — list_worker_types"
---

List every worker type you can spawn: the built-in / user / project types on disk PLUS the runtime types you have minted this session. Use it to re-check the catalog after minting (the snapshot in your system prompt is fixed at launch and does not include your later mints). Returns `[{ name, description, whenToUse, source }]`. Match a task against each `whenToUse`, then spawn with `workerType: <name>`.
