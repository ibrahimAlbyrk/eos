---
description: "Tool — run_routine"
---

Ask for a run of one of the user's routines: `routine` is its slug (`list_routines` shows them), `item` what the run works on (a link, a number, a short text), `note` an instruction for this run only, and `showOnly` to show the result in Eos and send it nowhere.

A routine runs at once only when the user let agents start it. Otherwise the user sees a card in this chat with the filled form and starts the run with one click: say what you proposed and wait. Never ask twice for the same run.

When the run's result is ready, and when the run ends, this chat gets a note with its headline. A result the run sends still goes through the user's Needs you first.

When to use:
- The user asks for something one of their routines does.
- Not to do the work yourself, and not for a routine the user did not ask for.
