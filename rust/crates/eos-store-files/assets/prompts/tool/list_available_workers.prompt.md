---
description: "Tool description — list_available_workers"
variables:
  - CREATE_WORKER_TOOL
  - LIST_ACTIVE_WORKERS_TOOL
---

List every available worker you can spawn from: the built-in / user / project definitions on disk PLUS the ones you have defined this session with {{CREATE_WORKER_TOOL}}. Use it to re-check the catalog after defining one (the snapshot in your system prompt is fixed at launch and does not include later definitions). Returns `[{ name, description, whenToUse, source }]`. Match a task against each `whenToUse`, then spawn with `from: <name>`.

NOT your running workers — this lists definitions (blueprints) you can spawn FROM. For workers that are actually running, use {{LIST_ACTIVE_WORKERS_TOOL}}.
