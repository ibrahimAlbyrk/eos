---
description: "Tool — list_capabilities"
variables:
  - CALL_CAPABILITY_TOOL
---

List what Eos can reach for the user beyond this computer: GitHub, Mail, notifications, and the capabilities the user added. Each comes with the actions you may call: a name, what it does, and its class (`read`, `write_local`, `tell_user`, `speak`, `irreversible`). A capability that does not work yet says what is missing and what the user does to set it up.

Pass `id` to see one capability in full: the input each action takes, and how to use it.

When to use:
- Before {{CALL_CAPABILITY_TOOL}}, to find the action and the input it takes.
- When the user asks what Eos can do for them, or a call fails because a capability is not ready.

You cannot set a capability up yourself: tell the user the step it names.
