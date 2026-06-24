---
description: "MCP tool — submit_step_output"
---

Return this workflow step's result as a structured JSON object. Call this when the step instructed you to return JSON matching an output schema — the `output` you pass IS the step's result, consumed directly by the next steps in the workflow.

Pass the result object as `output` (any JSON shape the step's schema requires). Match that schema exactly: if your output fails validation you will be re-prompted with the error and asked to correct it.

Call `submit_step_output` BEFORE your final `send_message_to_parent` report — the typed output is the step's value; the report is just your closing summary. Call it exactly once for a successful step.
