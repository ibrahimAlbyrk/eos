# Fixtures

What the 0.1.x app (the TypeScript implementation Eos users upgrade from) answered and computed,
frozen so the Rust app can be checked against it: the recorded wire (`wire/`) and the vectors
below. They are the reference by themselves: nothing here is generated any more. Everything was
recorded or computed from the TypeScript tree at commit `059c4b38`, the last state of it in this
repository, and on 2026-11-14 every recorder and generator ran once more against that tree before
it was removed: each corpus came out as committed (aside from the terminal launch vector's random session id and
the two migrations only the Rust app has), the recordings replayed against the Node daemon 1089
of 1089 steps, and `wire/routes.json` equals the table the daemon registered.

A fixture changes only when the Rust app answers differently on purpose, in the same commit as
that change; on the wire such a difference is listed in `wire/rust-differences.toml` instead.

## The wire

```
wire/recordings/*.json      what the daemon answered (normalized), one file per route group
wire/normalize.toml         the rules that make two runs read the same
wire/rust-differences.toml  where the Rust core differs on purpose, each with its reason
wire/routes.json            every route the daemon registered
wire/coverage.md            every route → recorded / errors only / not recorded (`wire-recorder coverage`)
wire/not-recordable.toml    why a route has no recorded success
wire/seed/                  the invented data folder the recordings were made on
private/                    recordings made on a copy of a real data folder — git-ignored
```

```bash
scripts/replay.sh [--only 11-chats,12-transcript] [--verbose]   # fresh synthetic folder, in process
scripts/replay.sh --private <copy>                              # against fixtures/private, values hidden
cargo run -p wire-recorder -- coverage --routes fixtures/wire/routes.json \
  --recordings fixtures/wire/recordings --notes fixtures/wire/not-recordable.toml --out fixtures/wire/coverage.md
```

`replay.sh` seeds a fresh synthetic folder (`wire/seed`; `wire-recorder seed --home DIR --sql
fixtures/wire/seed/state.sql --var sandbox=DIR` gives a folder its schema and the invented rows),
builds the composed app (`eos-app`) on it and calls its router directly (`--rust-home`): no
daemon, no port. A terminal's `claude` is a compiled stand-in for Claude Code
(`crates/eos-mod-terminals/examples/fake_claude.rs`): `scripts/stand-in-claude.sh` gives the run's
home shell profiles that put it first and stops the run unless the shell then finds the stand-in.

`replay` exits non-zero when anything differs and prints where:

```
31-pages: 25 of 26 steps match
  DIFF  create                       POST /api/pages
          /json/page/rev
            recorded 1
            got      2
```

What it adds besides comparing:

- a step whose route is not registered is not sent and not a difference: the recording's line says
  `N not served yet` (`--verbose` lists them), and steps that needed an id such a step would have
  captured wait with it;
- a difference that is meant to be there is listed in `wire/rust-differences.toml` with its reason
  (`differ as listed`): the run fails only on a difference nobody listed;
- recordings share one data folder, so once a write was not served, a later read that differs is
  counted apart (`read what an unserved write changes`) instead of failing: run a route group
  alone with `--only` to judge it strictly;
- generated ids are renumbered per side (`<worker:3>` → by first sight among the compared steps),
  because a side that skips steps meets the ids in another order;
- `--as-phone` asks every route the phone may call as the phone (the caller the phone gateway
  gives a control): the recordings must hold for it as they hold for the dashboard;
- `--redact` (always on with `--private`) prints where two answers differ and what kind of value
  sits there, never the values.

### Real data stays private

```bash
scripts/private-copy.sh <sanitized data folder> <copy>   # a copy no run can turn against the user's disk
scripts/replay.sh --private <copy>                       # the Rust core on it, values hidden
```

`fixtures/private` holds recordings the daemon made on a copy of a real data folder (never
commit, print or upload them). `private-copy.sh` moves every path of the user's home in the copy
(rows and files) into a throwaway folder beside it (`<copy>-sb`, each project folder a small git
repository with a fixed history), so a route that runs git in a chat's folder or sweeps a scratch
folder never meets the user's own; it turns archive retention and dreaming off, clears worktree
origins, and picks the chats the private recordings read (`private-vars.sh`) into `<copy>.vars`
before anything boots on the copy. The replay sends only GET and HEAD requests to a folder that
holds a `REAL_DATA` file (`--real-data`), whatever a recording says.

A private recording ages: the normalizer writes times within two days of the run as `<now>`, so a
date in the data that sat inside that window when recorded is a literal a few hours later. With
the daemon gone they cannot be recorded again: such a difference is the recording's age.

### A recording

A recording keeps each step next to its normalized answer:

- `request` (`"METHOD /path"`), `open` (`GET /stream` under a name; later steps record the frames
  they cause), `close`, or `join` (the answer of an earlier `detach`ed request);
- `{name}` is a variable: given on the command line (`sandbox`, `home`, `user_home`, `repo`, …)
  or captured from an earlier answer (`capture = { page = "/json/page/id" }`: a pointer into the
  raw answer, `[key=value]` picks the first array element whose `key` reads `value`, `[last]` the
  last one; after a stream event `{<stream>.last_id}` holds its id). `{{name}}` is the literal
  text `{name}`;
- `auth = "none"` leaves the ui-token out; `via = "raw"` uses the raw-content origin, `via =
  "socket"` the control socket; `headers` adds headers;
- bodies: `body` (JSON), `json` (JSON as text), `text` + `content_type`, `base64`;
- `wait` names stream reasons that must arrive before the step is done; `optional` skips a step
  whose variable was never captured; `pause_ms` waits before it.

### Normalizing

`normalize.toml` is data. A response is one document — `status`, `headers`, then `json` or `text`
or `bytes` + `sha256`, and `frames` per open stream — and each rule names a place and one action:

| Where (all must hold) | |
|---|---|
| `route = "GET /workers/*/events"` | glob over the request as the recording wrote it |
| `reason = "pty:data"` | a stream frame with that reason; `at` is then relative to the frame |
| `at = "/json/items/*/mtime"` | pointer glob: `*` one segment, `**` any number |
| `key = ["durationMs"]` | an object key at any depth |
| `matches = '…'` | the whole string value |

| Action | |
|---|---|
| `set = …` | replace the value |
| `now = "<now>"` | replace times within two days of the run (numbers, and ISO dates or epoch ms inside strings); seeded times stay |
| `token = "worker"` with `find` or `matches` | replace each hit by `<worker:N>`, the same N for the same text across the recording |
| `find` + `replace` | rewrite inside strings |
| `sort_by = "/name"` | sort an array whose order is not promised |
| `shape = true` | keep keys and value types only |
| `drop = true` | remove the value, or the frame when a `reason` is given without `at` |
| `collapse = true` | keep the first of consecutive frames with that `reason` |

Variables given on the command line are written back as `{name}` wherever their value appears.
Object key order is not recorded. `wire-recorder` replays against a `Target`
(`tools/wire-recorder/src/target.rs`): `RustTarget` (`inproc.rs`) is the Rust core's router in
process.

## Vectors

What the TypeScript computed for inputs no route shows, frozen at `059c4b38`.

| Corpus | What the TypeScript computed | Held to it |
|---|---|---|
| `browser/` | 292 accessibility trees rendered as snapshot text with their refs, roles and states of 200 nodes, 56 key chords, 434 navigations against the origin allowlist, header redaction, storage names | `eos-mod-browser` |
| `policy/` | 47,040 permission decisions over policies × tools × inputs × modes × tool scopes; each policy text as the `yaml` package read it (the fourth is the bundled policy) | `eos-policy`, the `policy.yaml` reader |
| `workers/` | resolution, `extends`, defaults, the catalog, model tiers | `eos-workers`, the definition-file reader |
| `prompts/` | every prompt read and rendered, 641 assembled system prompts byte for byte; `files.json`: each library file's SHA-256 as the 0.1.x app shipped it | `eos-prompts`, the library in `eos-store-files` |
| `genui/` | the visual-answer parsers, validator and catalog over generated and hand-picked inputs, the catalog prompt | `eos-genui` |
| `genui-media/` | what a page names as its preview image and icons, image sniffing, cache keys and files, the map proxy's paths and rewritten documents, Nominatim requests and answers, Overpass queries, elements as `Place` entities, distances | `eos-genui-media` |
| `relay/` | the relay envelope and the relay's own messages from both codecs, the phone's inner frames as the framer writes them, which client payloads the gateway takes, the pairing code, whole sessions through the gateway, bridge, patcher and live text | `eos-relay`, `eos-mod-remote` |
| `tools/` | the tool list of each kind of session with built-in plugins on and off, every input schema, 913 inputs through the MCP server, 100 handler runs over scripted answers, the date and time | `eos-tools` |
| `subagent-lists/` | a chat's subagents and artifacts as summaries: 8 invented logs through the `/subagent-events` selection and the dashboard's own `messageParser.js`, `collectSubagents` and `collectArtifacts` | `eos-domain`, `eos-mod-workers` |
| `update/` | the chunker's cut points and ids, a release built and signed by the publisher | `eos-domain::update`, `eos-update`, `cargo xtask publish-update` |
| `claude-plugin/` | each file's SHA-256 of the plugin-authoring skill as the 0.1.x app shipped it | `assets/claude-plugin` (`eos-plugin-files`) |

Next to the crates that read them, from the same tree: `eos-contracts/tests/vectors` (every Zod
schema's answer to ~4,800 inputs) and `tests/golden` (the `ROUTES` table, the built-in plugin
manifests); `eos-kit-sqlite/migrations` and `tests/fixtures/ts-schema.json` (the migrations and
the schema they build); `eos-domain/tests/fixtures` (pages, memories, profiles, sync records,
Claude transcripts as rows); `eos-store-files/tests/fixtures/store-vectors.json`;
`eos-profile/tests/fixtures/render-vectors.json`; `eos-engine/tests/vectors` (the SDK event
mapper over scripted streams); `eos-pty/tests/fixtures/mirror-vectors.json` (the screen mirror);
`eos-mod-terminals/tests/fixtures/terminal-vectors.json`;
`eos-plugin-build/tests/samples/expected.json` (the plugin builder over esbuild 0.28.2);
`eos-mod-plugins/tests/vectors/manifests.json`; `eos-peer/tests/vectors/stores` (the peer lists
and relay room as the 0.1.x stores wrote them). `eos-kit-fs/tests/fixtures/yaml-vectors.json` is
the `yaml` package's own writer (`crates/eos-kit-fs/scripts`, which needs no TypeScript).
