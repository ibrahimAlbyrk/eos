---
description: "Tool — page_design_propose"
variables:
  - PAGE_CATALOG
  - SUBMIT_RESULT_TOOL
---

Propose a design for the routine's page. Eos checks it, draws it with its sample and with real data, and lays it out at a phone's width and a wide window's; only a design that passes every check is shown to the user, beside the one they have.

- `template`, `style`, `contract`, `sample`: the design, as the catalog below says.
- `tile` (optional): what the page's tile on Home shows.
- `uses`, `queries` (optional): the direct actions its Buttons run and the named queries its Live parts read.
- `note`: one line the user reads beside the change, such as "A smaller lead story and a wider rail".

The answer says the version passed, or that it waits for Eos's window, or lists every problem with its place: fix them all and propose again. Then end the run with {{SUBMIT_RESULT_TOOL}}, kind `nothing`.

{{PAGE_CATALOG}}
