# eos-contracts

Every shape that crosses a boundary of Eos, as serde types: what the dashboard, the phone and
paired computers send and receive, as the 0.1.x app's Zod schemas defined them; the visual-answer
parsers and catalog are `eos-genui`'s. Names are the Zod schemas' without the `Schema` suffix
(`WorkerRowSchema` → `WorkerRow`), and everything is re-exported from the crate root.

## Modules

| Module | Holds |
|---|---|
| `primitives` | `Num` (a JavaScript number: writes `50`, not `50.0`), `BoolLit` / `IntLit` / `str_lit!` (literal-valued fields), the serde helpers behind field attributes |
| `validate` | `Validate`, `parse` (read + check, Zod's `safeParse`), `read` (shape only), `ValidationError` and its `invalid request: …` text |
| `routes` | the route table (`ROUTES`, one `Route` constant per `ROUTES` key, with methods) |
| `route_planes` | which routes stay on this Mac (`KERNEL_LOCAL_ONLY_ROUTES`, `PEER_OPEN_ROUTES`) |
| `stream` | the event stream's frame payloads and the kernel's bus topic names |
| `canonical`, `events`, `worker`, `task` | agent events, transcript event rows and their payloads, worker rows — what the phone parses |
| `http::*` | request / response bodies by route area: `workers`, `git`, `fs`, `terminal`, `pages`, `templates`, `settings`, `config`, `policy`, `questions`, `rewind`, `symbols`, `commands`, `prompts`, `project_memory`, `worker_definitions`, `system` |
| `accounts`, `usage`, `artifacts`, `plugin`, `plugin_install`, `background_job`, `workflow_run`, `side_question`, `profile`, `dream`, `sync`, `transfer`, `update`, `peer`, `remote`, `browser`, `genui` | one feature's wire types each |
| `backend`, `provider_capabilities`, `memory`, `prompt`, `policy`, `worker_definition`, `anthropic`, `shared` | shapes of files and config (`policy.yaml`, prompt frontmatter, worker definitions, backend profiles) |
| `artifact_ids`, `attachments`, `builtin_plugins`, `builtin_tools`, `tool_scope`, `util` | ids and small pure helpers |
| `schema` | `json_schema_bundle()` |

## Rules a type follows

- Optional (`.optional()`) → `Option<T>`, left out when `None`. Nullable and required → `Option<T>`
  with `de::required` (a missing key is "Required", as in Zod). Both → `Option<Option<T>>`:
  `None` absent, `Some(None)` `null`.
- `z.unknown()` → `Option<Value>` that keeps a present `null`. `.passthrough()` → an `extra` map.
  `.strict()` → `deny_unknown_fields`. Everything else ignores unknown keys.
- `z.number()` → `Num`; `.int()` → `i64`. Records are `IndexMap`: key order survives.
- Lengths, ranges, patterns and refinements are in `impl Validate`, with Zod's messages; a request
  handler calls `parse`, which answers as the recorded wire does.

## Adding or changing a type

1. Write the struct in the module of its area and `impl Validate` (empty when it has no rules).
2. List it in `schema.rs`.
3. A new route: add its constant to `routes/table.rs` and to `ROUTES`, marked `added` when the
   0.1.x table never had it.

## Generators and tests

- `cargo xtask contracts [dir]` writes `schema.json` (JSON Schema of every type), `routes.json`
  and `routes.js` to `target/generated/contracts`. An xtask test compares `routes.js` with the
  dashboard's `app/ui/src/api/routes.js` entry by entry.
- `tests/zod_vectors.rs`: every Zod schema parsed ~4,800 sample inputs (`tests/vectors`, frozen
  from the 0.1.x app, see `fixtures/README.md`); each Rust type must accept and reject the
  same ones, write the same JSON and word a single failure the same way.
- `tests/wire_fixtures.rs`: every body, stream payload and request the wire recorder captured
  (`fixtures/wire`, or `EOS_WIRE_FIXTURES=<dir>`) through the type of its route.
- `tests/routes.rs`: the table against the 0.1.x `ROUTES` (`tests/golden/routes.json`) and
  the methods the daemon registered (`fixtures/wire/routes.json`), both frozen.

## Where Rust differs from Zod, on purpose

- A type error stops at the first one; Zod lists all. Constraint failures are all reported.
- A bad union tag reads `Invalid enum value. Expected 'a' | 'b', received 'x'` (Zod: `Invalid
  discriminator value. Expected 'a' | 'b'`).
- `null` for an optional, non-nullable field is read as absent (Zod refuses it).
- `HealthResponse.fds`, `ModelPricing` (tiered prices, `cacheCreate1h`), the extra capability flags
  of `UiBackendDescriptor` and the extra keys of `ErrorResponse` are on the recorded wire but not in
  the Zod schemas; the types carry them.
- The JSON Schema bundle describes shapes only, not the `Validate` rules.
- The app has no goal loops: what carries a loop is left
  out (`loop` on a worker row, `held` on a report answer, the `loop_continuation` and `loop_check`
  event kinds). A spawn request's `loop` is read as any JSON, so the route can refuse it.
