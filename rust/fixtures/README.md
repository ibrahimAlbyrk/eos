# Wire fixtures

What today's Node daemon answers, frozen route by route, so the Rust core can be checked against
it. The tool is `tools/wire-recorder`; the data is here.

```
wire/scenarios/*.toml     what to ask, one file per route group, run in file-name order
wire/recordings/*.json    what the daemon answered (normalized), one file per scenario
wire/normalize.toml       the rules that make two runs read the same
wire/routes.json          every route the daemon registers (written by the recording run)
wire/coverage.md          every route → recorded / errors only / not recorded (generated)
wire/not-recordable.toml  why a route has no recorded success
wire/seed/                the invented data folder the recordings are made on
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
`infra`, `gateway`, `spawner`, `manager`) and never touch `~/.eos` or a running Eos. Arguments
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

## Real data stays private

```bash
cp -R <sanitized copy of a data folder> <copy>
scripts/wire.sh record-private <copy>    # → fixtures/private (never commit, print or upload)
scripts/wire.sh replay-private <copy>
```

A real data folder holds real session ids and paths. Three things keep a recording run from
touching anything real:

- only scenarios marked `read_only = true` run, and such a scenario may hold nothing but GET and
  HEAD requests (checked when it is loaded);
- the tool refuses every other request when started with `--real-data` or when the data folder
  holds a `REAL_DATA` file (`wire.sh` does both) — in code, whatever the scenario says;
- the daemon runs with `$HOME` and `CLAUDE_CONFIG_DIR` pointing into the run folder, so a `claude`
  process could only write there.

Before the first run on a copy, set `archive.retention` to `"off"` in its `config.json` and
`dreaming.enabled` to `false` in `profile/profile.json`.

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
`POST /orchestrators`), never end (`/stream`) or go to the network.

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
`fork`. Today the only one is `HttpTarget` (API port, raw port, unix socket). The Rust core's
in-process router implements the same trait, and the recordings replay against it unchanged.
