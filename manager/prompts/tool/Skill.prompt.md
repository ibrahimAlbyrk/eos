---
description: "Built-in tool — Skill (load an Agent Skill on demand)"
---
Load an Agent Skill's instructions on demand by name.

Usage:
- Pass the `name` of one of the skills listed in your instructions. The tool returns that skill's full instructions plus the absolute directory holding any scripts or assets the skill bundles.
- Use a skill when the task matches its description — load it first, then follow its instructions. Reach bundled scripts/assets under the returned directory with the Bash or Read tools.
- Only skills listed in your instructions are available; an unknown name returns an error. This tool loads a skill on request — it does not auto-trigger.
