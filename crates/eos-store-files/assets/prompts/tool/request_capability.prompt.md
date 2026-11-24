---
description: "Tool — request_capability"
---

Ask Eos for something it cannot do yet (send an SMS, read a calendar). Eos's Forge looks for the ways to do it, with what each costs and reaches, and asks the user to pick one; only then does it build anything, in a sandbox, and the user installs it only after its tests and a review. You never build or install it yourself.

- `need`: what is missing, in a plain sentence the user reads ("Send me a text message"). To ask for one that list_capabilities lists but that does not work yet, give its id.
- `routineId`: the routine that waits for it, if any.

When the capability exists but is not set up, the answer is the step the user takes: tell the user that step. Otherwise the answer names the Forge's run; the user follows it in Needs you.
