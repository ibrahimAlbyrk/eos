---
description: "Built-in tool — BashOutput"
---
Retrieves output from a running or completed background shell that was started with the Bash tool's `run_in_background` parameter.

Usage:
- Provide the `bash_id` returned when the background shell was started.
- Returns any new output produced since the previous read — output is delivered incrementally, so repeated calls do not repeat earlier output.
- Also reports the shell's status: whether it is still running, or its exit code if it has completed.
