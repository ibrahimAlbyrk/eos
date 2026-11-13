# Wire fixtures

What today's Node daemon answers, frozen route by route, so the Rust core can be checked against
it. The tool is `tools/wire-recorder`; the data is here.

```
wire/scenarios/*.toml     what to ask, one file per route group, run in file-name order
wire/recordings/*.json    what the daemon answered (normalized), one file per scenario
wire/normalize.toml       the rules that make two runs read the same
wire/rust-differences.toml  where the Rust core differs on purpose or for now, each with its reason
wire/routes.json          every route the daemon registers (written by the recording run)
wire/coverage.md          every route → recorded / errors only / not recorded (generated)
wire/not-recordable.toml  why a route has no recorded success
wire/seed/                the invented data folder the recordings are made on
wire/scenarios-private/   read-only scenarios that only run on a copy of a real data folder
private/                  recordings made on a copy of a real data folder — git-ignored
```

## Record and replay

```bash
scripts/wire.sh record    # fresh synthetic folder → recordings, routes.json, coverage.md
scripts/wire.sh replay    # another fresh synthetic folder, diffed against the recordings
```

Both start the Node daemon from this checkout in isolation (`scripts/wire-daemon.sh`): its own
data folder and `$HOME` under `$TMPDIR/eos-wire`, ports 7500/7501, no launchd, phone relay and
hosting off, UTC. They need the daemon's packages installed (`npm install` in `contracts`, `core`,
`infra`, `gateway`, `spawner`, `manager`) and never touch `~/.eos` or a running Eos. A terminal's
`claude` is a compiled stand-in for Claude Code (`crates/eos-mod-terminals/examples/fake_claude.rs`):
`scripts/stand-in-claude.sh` gives the run's home shell profiles that put it first (a macOS login
shell puts `/etc/paths.d`, Homebrew's folder among them, ahead of the PATH it is given) and stops the
run unless the shell then finds the stand-in. `replay.sh` does the same for the Rust core. Arguments
after the mode go to the tool: `--only 31-pages,32-profile`, `--verbose`, `--lenient`.

`replay` exits non-zero when anything differs and prints where:

```
31-pages: 25 of 26 steps match
  DIFF  create                       POST /api/pages
          /json/page/rev
            recorded 1
            got      2
```

While writing scenarios, keep one seeded daemon up and run against it:

```bash
scripts/wire.sh up
EOS_WIRE_REUSE=1 scripts/wire.sh record --lenient --only 31-pages   # unexpected statuses are warnings
scripts/wire.sh down
```

## Replaying against the Rust core

```bash
scripts/replay.sh [--only 11-chats,12-transcript] [--verbose]   # fresh synthetic folder, in process
scripts/replay.sh --private <copy>                              # against fixtures/private, values hidden
```

The tool builds the composed app (`eos-app`) on the data folder and calls its router directly
(`--rust-home`): no daemon, no port. What it adds for a core that is still growing:

- a step whose route is not registered is not sent and not a difference: the scenario's line says
  `N not served yet` (`--verbose` lists them), and steps that needed an id such a step would have
  captured wait with it;
- a difference that is meant to be there is listed in `wire/rust-differences.toml` with its reason
  (`differ as listed`): the run fails only on a difference nobody listed. An entry that says
  "until …" is removed by the work that lands it;
- scenarios share one data folder, so once a write was not served, a later read that differs is
  counted apart (`read what an unserved write changes`) instead of failing: run a route group
  alone with `--only` to judge it strictly;
- generated ids are renumbered per side (`<worker:3>` → by first sight among the compared steps),
  because a side that skips steps meets the ids in another order;
- `--as-phone` asks every route the phone may call as the phone (the caller the phone gateway
  gives a control): the recordings must hold for it as they hold for the dashboard;
- `--redact` (always on with `--private`) prints where two answers differ and what kind of value
  sits there, never the values.

A private recording ages: the normalizer writes times within two days of the run as `<now>`, so a
date in the data that sat inside that window when recorded is a literal a few hours later.
Record again (`wire.sh record-private`) when a replay differs only at such a place.

`wire-recorder seed --home DIR --sql fixtures/wire/seed/state.sql --var sandbox=DIR` gives a folder
its schema and the invented rows, as the recording run's first boot did.

## Real data stays private

```bash
scripts/private-copy.sh <sanitized data folder> <copy-n>   # the copy the daemon reads
scripts/wire.sh record-private <copy-n>                    # → fixtures/private (never commit, print or upload)
scripts/private-copy.sh <sanitized data folder> <copy-r>   # a fresh copy, path of the same length
scripts/replay.sh --private <copy-r>                       # the Rust core on it, values hidden
```

`private-copy.sh` moves every path of the user's home in the copy (rows and files) into a
throwaway folder beside it (`<copy>-sb`, each project folder a small git repository with a fixed
history), so a route that runs git in a chat's folder or sweeps a scratch folder never meets the
user's own; it turns archive retention and dreaming off, clears worktree origins, and picks the
chats the private scenarios read (`private-vars.sh`: newest, oldest, largest, archived, with
subagents, workflow runs, compaction, questions, …) into `<copy>.vars` before anything boots on
the copy. Besides the `read_only` scenarios of `wire/scenarios`, a private run records
`wire/scenarios-private` (every transcript read per picked chat, every feature's lists, the
stream's resume after a boot), which only ever run on such a copy.

A real data folder holds real session ids and paths. Three things keep a recording run from
touching anything real:

- only scenarios marked `read_only = true` run, and such a scenario may hold nothing but GET and
  HEAD requests (checked when it is loaded);
- the tool refuses every other request when started with `--real-data` or when the data folder
  holds a `REAL_DATA` file (`wire.sh` does both) — in code, whatever the scenario says;
- the daemon runs with `$HOME` and `CLAUDE_CONFIG_DIR` pointing into the run folder, so a `claude`
  process could only write there.


## A scenario

```toml
about = "Pages: create and read."
# read_only = true             # safe on real data: GET/HEAD only, ids found by capture
# record_headers = ["vary"]    # response headers kept on top of normalize.toml's list

[[step]]
name = "open-stream"
open = "main"                  # GET /stream; later steps record the frames they cause
query = { topics = "pages:*" }

[[step]]
name = "create"
request = "POST /api/pages"
body = { title = "Notes", project = "{sandbox}/alpha" }
status = 201                   # what the author expects; recording stops on another answer
capture = { page = "/json/page/id" }
wait = ["pages:change"]        # reasons that must arrive on a stream before the step is done

[[step]]
name = "read"
request = "GET /api/pages/{page}"
status = 200

[[step]]
name = "close-stream"
close = "main"
```

- `{name}` is a variable: given by `wire.sh` (`sandbox`, `home`, `user_home`, `repo`, …) or
  captured from an earlier answer. `{{name}}` is the literal text `{name}`.
- A capture is a pointer into the raw answer (`/status`, `/headers/etag`, `/json/…`,
  `/frames/<stream>/0/…`); `[key=value]` picks the first array element whose `key` reads `value`,
  `[last]` the last one. After a stream event, `{<stream>.last_id}` holds its id.
- `auth = "none"` leaves the ui-token out. `via = "raw"` uses the raw-content port, `via = "socket"`
  the control socket. `headers = { … }` adds headers, a `host` header replaces the default one.
- Bodies: `body` (JSON), `json` (JSON as text, for `null` or an array), `text` + `content_type`,
  `base64`.
- `detach = true` sends a request that stays open (a permission ask); a later `join = "<step>"`
  records its answer and states the status.
- `optional = true` skips a step whose variable was never captured (an empty list on real data).
- `pause_ms` waits before a step.

A recording keeps each step next to its answer, so `replay` needs only the recording.

## Adding a scenario later

1. Write `wire/scenarios/NN-name.toml`. Reads before writes: a scenario sees what earlier files
   left behind, so files that change shared rows come late and `90-gates` stays last.
2. If it needs data, add invented rows to `wire/seed/state.sql` (ids in capitals stay readable;
   lowercase ids are treated as generated) or files to `wire/seed/`.
3. `scripts/wire.sh up`, record leniently, read the recording, fix the statuses.
4. `scripts/wire.sh record` then `scripts/wire.sh replay`. A difference is either a real
   run-to-run difference — add a rule to `normalize.toml` saying why — or a scenario that depends
   on timing.
5. A route that cannot be recorded gets a line in `not-recordable.toml`; `wire-recorder coverage`
   fails while a route has neither a recorded success nor a reason.

`90-gates.toml` is generated: one request per registered route with no token, no body and a
placeholder id. Regenerate it from `routes.json` when routes are added, leaving out the routes
that open a dialog (`/pick-directory`, `/pick-file`), start an agent (`POST /workers`,
`POST /orchestrators`), never end (`/stream`) or go to the network, and `POST /workers/:id/events`,
which the Rust app does not have.

## Normalizing

`normalize.toml` is data. A response is one document — `status`, `headers`, then `json` or `text`
or `bytes` + `sha256`, and `frames` per open stream — and each rule names a place and one action:

| Where (all must hold) | |
|---|---|
| `route = "GET /workers/*/events"` | glob over the request as the scenario wrote it |
| `reason = "pty:data"` | a stream frame with that reason; `at` is then relative to the frame |
| `at = "/json/items/*/mtime"` | pointer glob: `*` one segment, `**` any number |
| `key = ["durationMs"]` | an object key at any depth |
| `matches = '…'` | the whole string value |

| Action | |
|---|---|
| `set = …` | replace the value |
| `now = "<now>"` | replace times within two days of the run (numbers, and ISO dates or epoch ms inside strings); seeded times stay |
| `token = "worker"` with `find` or `matches` | replace each hit by `<worker:N>`, the same N for the same text across the scenario |
| `find` + `replace` | rewrite inside strings |
| `sort_by = "/name"` | sort an array whose order is not promised |
| `shape = true` | keep keys and value types only |
| `drop = true` | remove the value, or the frame when a `reason` is given without `at` |
| `collapse = true` | keep the first of consecutive frames with that `reason` |

Variables given on the command line are written back as `{name}` wherever their value appears.
Object key order is not recorded.

## The target

`wire-recorder` talks to a `Target` (`tools/wire-recorder/src/target.rs`): `send`, `open_stream`,
`fork`, `serves`. `HttpTarget` is a daemon behind the API port, the raw port or the unix socket;
`RustTarget` (`inproc.rs`) is the Rust core's router in process, and the recordings replay against
it unchanged.

## Vectors from the TypeScript

Besides the recorded wire, these corpora hold what today's TypeScript computes for inputs no
route shows. Each is written by a Node script that imports the TypeScript sources directly
(Node ≥ 23.6; `npm ci` in `contracts/`, `core/`, `infra/`), and each has `--check` to say
whether the committed corpus is still what the sources produce.

| Corpus | Written by | Held to it |
|---|---|---|
| `browser/` | `tools/browser-vectors/generate.mjs` | `eos-mod-browser` (292 accessibility trees rendered as snapshot text with their refs, roles and states of 200 nodes, 56 key chords, 434 navigations against the origin allowlist, header redaction, storage names) |
| `policy/` | `tools/policy-vectors/generate.mjs` | `eos-policy` (47,040 permission decisions over policies × tools × inputs × modes × tool scopes), the `policy.yaml` reader |
| `workers/` | `tools/workers-vectors/generate.mjs` | `eos-workers` (resolution, `extends`, defaults, the catalog), the definition-file reader, model tiers |
| `prompts/` | `tools/prompt-vectors/generate.mjs` | `eos-prompts` and the shipped library (every prompt read and rendered, 641 assembled system prompts byte for byte) |
| `genui-media/` | `tools/genui-media-vectors/generate.mjs` | `eos-genui-media` (what a page names as its preview image and icons, image sniffing, cache keys and files, the map proxy's paths and rewritten documents, Nominatim requests and answers, Overpass queries, elements as `Place` entities, distances) |
| `relay/` | `tools/relay-vectors/generate.mjs` (needs `npm ci` in `contracts/` only) | `eos-relay` (the relay envelope and the relay's own messages, byte for byte, from both TypeScript codecs), `eos-mod-remote` (the phone's inner frames as the framer writes them, which client payloads the gateway takes, the pairing code, and whole sessions against the TypeScript gateway, bridge, patcher and live text: every frame each phone received) |
| `tools/` | `tools/tools-vectors/generate.mjs` (`npm install` in that folder only) | `eos-tools`: the tool list of each kind of session with built-in plugins on and off, every input schema, 913 inputs through the MCP server the tools were registered on (what the handler gets, or the refusal the model reads), 100 handler runs over scripted answers (the result text), the date and time |
| `subagent-lists/` | `tools/subagent-lists-vectors/generate.mjs` (needs `npm ci` in `app/ui` only: it runs the dashboard's own parser) | `eos-domain` and `eos-mod-workers` (a chat's subagents and artifacts as summaries: 8 invented logs through today's `/subagent-events` selection, `messageParser.js`, `collectSubagents` and `collectArtifacts`, covering both lanes' rows, background runs, continued subagents, rewinds, clears, recalls and every kind of `Artifact` call). `parity.mjs` in the same folder compares the core with the same derivation over a whole data folder (`subagent_lists_dump`), printing counts only |
