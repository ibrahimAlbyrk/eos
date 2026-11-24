---
description: "Tool — forge_report"
---

Hand Eos the report of your stage of the Forge, in the shape your brief gives for it. Eos keeps it with the run: the user picks from the research, Eos tests and installs what the build names, and the review decides whether the user is asked at all.

- `stage`: `research`, `build` or `review`; only your own stage is taken.
- `report`: the report itself, as an object.

A report of the wrong shape is refused with what is wrong: fix it and call this again. A later report of the same stage replaces the earlier one.
