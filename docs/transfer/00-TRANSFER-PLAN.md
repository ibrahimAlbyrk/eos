# File transfer — implementation plan

Status: implemented (phases 0–5). Tests: core `transfer.test.ts`, infra
`FsTransferEndpoint.test.ts`, manager `transfer-service`, `peer-transfer` (over a real
pairing), `routes/transfer`, tool registration/parity, UI `views/transfer/transfer.test.jsx`.

Copy files and folders between paired Macs from inside Eos. Today the only ways across are
`/fs/paste` (≤ 20 MB, lands in a temp folder) and the host view's `saveFile` bridge (≤ 64 MB,
base64 over IPC, one file) — a game build made by an agent on another Mac can't be brought
home. Design chosen: **B · Transfer panel** (a side-panel tab: From ⇄ To, browse the source,
pick, copy) — canvas: https://claude.ai/artifact/LE5mBkW8r5RSVdLQK7LRai.

## Decisions (confirmed)

- **Host views are in v1** (phase 4), **agents can send files** (phase 5, focused sessions),
  default folder `~/Downloads/Eos`, and the cross-Mac admission hole is fixed first (phase 0).
- **The engine runs on the Mac you sit at.** The peer link only goes device → host (no
  push from a host without a second, mutual pairing). The device reaches its own disk and
  every host, so it does both directions: pull = read the host, write here; push = read
  here, write the host.
- **v1 pairs are "This Mac ⇄ one paired Mac".** The engine talks to two `TransferEndpoint`s
  and doesn't care which is local, so host ⇄ host later is a UI change only.
- **Per-file, chunked, resumable copies over the existing HostLink HTTP/2 session.** No tar,
  no relay or link changes. Chunking is what makes the link's limits harmless (see Engine).
- **Staged, then committed.** Bytes land in a hidden staging folder inside the destination
  (same volume ⇒ the final step is a rename). Nothing appears half-written.
- **Conflicts per top-level item:** Replace (the old one goes to the Trash, Finder "Put
  Back" works) · Keep both (`name 2.ext`, Finder's naming) · Skip · "same for the rest".
- **Destination default:** the same project on the other Mac — matched by git remote with
  the existing `project-keys` — keeping the sub-folder (`builds/` → `builds/`); otherwise
  `~/Downloads/Eos`. Always changeable.
- **Kept:** folder tree, symlinks (as links), the executable bit, mtimes. **Not kept:**
  xattrs (no quarantine flag, so a copied `.app` opens without a Gatekeeper prompt), ACLs,
  owners. `.app` bundles stay signed: every file incl. `_CodeSignature` + symlinks copy.
- **Both Macs need this build.** New routes change the API stamp; an older peer answers
  404 ⇒ the panel says "Update Eos on Mac Studio to transfer files".

## Shape

```
Transfer tab (UI) ──/api/transfers (local-only, ui-token)──▶ TransferService (this Mac)
                                                               │  TransferEndpoint port
                         LocalEndpoint (in-process) ◀──────────┤
                                                               └──▶ PeerEndpoint ── HostLink h2 ──▶ host /transfer/*
                                                                                                         │
                                       both sides run the same FsTransferEndpoint (infra) ◀──────────────┘
```

## Endpoint layer — every daemon (`/transfer/*`)

One infra adapter, `infra/src/transfer/FsTransferEndpoint.ts`, used in-process for this Mac
and behind thin routes for a peer. Routes need the host's ui-token, which the host's gateway
attaches only when the device vouches for a human (`x-eos-peer-human: 1`) — so an agent on
either Mac can't drive them. Forwardable (not local-only).

| Route | Does |
|---|---|
| `GET  /transfer/list?path=` | one folder: `{name, path, type, size?, mtimeMs, isSymlink}` — no `fsIgnore` (shows `build/`, `dist/`), dotfiles optional |
| `POST /transfer/scan {paths}` | recursive manifest: `{relPath, type, size, mtimeMs, mode, linkTarget?}` + totals |
| `GET  /transfer/read?path=&size=&mtime=` | Range read of one file; `412` if the file changed since the scan |
| `PUT  /transfer/write?id=&rel=&offset=` | one chunk appended to the staged file; `409 {have}` if `offset` ≠ staged size |
| `POST /transfer/prepare {id, destDir, manifest}` | make staging, report conflicts, free space, and bytes already staged (resume) |
| `POST /transfer/commit {id, decisions}` | dirs → files → symlinks into place, apply Replace/Keep both/Skip, restore mode + mtime, drop staging |
| `POST /transfer/abort {id}` | drop staging |
| `POST /transfer/resolve {key}` | project key → local folder or `null` (a read-only `findPath`, no learning) |

Rules in the adapter: absolute paths only; every `relPath` normalized, no `..`/absolute/NUL;
refuse a destination under `~/.eos`; staging is `<destDir>/.eos-incoming-<id>/`, created
fresh, symlinks written last and never written *through*; free space checked in `prepare`
("needs 169 MB, 120 MB free"). `.eos-incoming-*` joins `fsIgnore` so the Files panel and
`/fs/list` skip it.

## Engine — this Mac (`TransferService`)

- **core** (`core/src/domain/transfer.ts`, `core/src/use-cases/PlanTransfer.ts`): the
  `Transfer` record + state machine (`queued → scanning → waiting-conflict? → copying ⇄
  paused → committing → done | failed | cancelled | interrupted`), the planner (manifest →
  work list, conflicts, `name 2.ext`, totals), chunk sizing, progress/rate/ETA (EWMA).
  Ports: `TransferEndpoint`, `TransferRepo`, `Clock`. No Node imports.
- **manager** (`manager/services/transfer/`): `TransferService` (queue, one active transfer
  per link, file workers, chunk loop, retry/backoff, pause/resume/cancel, publishes
  `transfer:change`, fires `notification:fire` with `route: "transfers"` on done/failed),
  `PeerEndpoint` (requests on `hostLinks.link(id).ready()` with `x-eos-peer-human: 1` — the
  daemon vouches for its own engine: a transfer starts only from a ui-token route or the
  locked-down agent route of phase 5), `LocalEndpoint`.
- **persistence**: `062_transfers` in state.db (regenerable: history + what to resume).
  Bytes done are re-read from staging via `prepare`, never trusted from the db. On boot a
  `copying` transfer becomes `interrupted` (Resume).

Why chunked — the link's real limits, each defused the same way:

| Limit (today) | Effect on one long stream | With chunks |
|---|---|---|
| Node `requestTimeout` 300 s (uploads, both servers) | a big push gets 408 | each PUT is seconds |
| relay → direct upgrade destroys the old session after 5 s | in-flight copy cut | the chunk retries from the staged size |
| PING answer > 6 s kills the session; relay buffers without limit | a 16 MB window queued on a slow relay starves PING | ≤ chunk × in-flight bytes queued |

Sizing: target ~1 s of measured throughput per chunk, clamped to 256 KiB – 16 MiB; in flight
4 on `direct`, 2 on `relay`/`reverse`; files < 256 KiB go 8 at a time (one request each).
A dropped link pauses the transfer on `link.ready()`, then resumes on its own.

## Device API — local-only, ui-token

`GET /api/transfers` · `POST /api/transfers {from, to, paths, destDir | "auto"}` ·
`POST /api/transfers/:id/{pause|resume|cancel|resolve}` · `DELETE /api/transfers` (clear
finished) · `GET /api/transfers/destination?from=&to=&path=` (suggested folder + why).
Added to `LOCAL_ONLY_ROUTES`, so no other Mac can start, see or steer them.

## UI — `app/ui/src/views/transfer/`

- Panel type `transfer` (`registerPanels.js`, `panelTabMeta.jsx` icon/label, `AGENT_TABS`,
  Code view `PANEL_TABS`, a `ToolMeta` line in the launcher). Opens with
  `ui.openPanel("transfer", {from, path})`.
- `RouteHeader` — From / To cards (`MachineGlyph`), This Mac fixed on one side, the other a
  glass menu of paired Macs (offline disabled), swap button; `direct · 4 ms · end-to-end
  encrypted` line from `hostsStore`.
- `SourceBrowser` — breadcrumb + place chips (matched project, Desktop, Downloads, Home),
  a checklist of one folder at a time (a folder opens on its name; ticking it takes all of
  it, a folder holding ticked items shows a dash and "2 selected"; ticks survive moving
  between folders — simpler than the mock's inline tree). Starts in the current chat's project on
  the source Mac, else home. Files show size; a folder's size appears once ticked (scan) —
  the mock's sizes on unticked folders would need a full walk per folder, so they go.
- `Destination` — suggested folder + "Same project on this Mac — matched by its git
  remote"; Change = native folder picker (this Mac) or `RemotePicker` aimed at that host
  (gains a `hostId`).
- `ActionBar` — "2 items · 169.2 MB" + "Copy to This Mac" / "Copy to Mac Studio".
- `TransferCard` — in flight / already there / done / failed-interrupted (Resume); Show in
  Finder only for a local destination. `Recent` stays one collapsed row until opened.
- `state/transfersStore.js` (module singleton, `transfer:change` in `useLive.js`, refetch on
  resync). `formatBytes` moves from `fileViewers.jsx` to `lib/format.js` (shared, not copied).
- A notification click opens the tab: `route === "transfers"` in `App.jsx`.

## Host views (phase 4)

A host view's code is sandboxed to that host's API (CSP), so it can't reach this Mac's
daemon. A narrow preload bridge, `eosTransfer`, carries just enough — given **only** to host
views running Eos's own bundle (`bundleSource === "local"`), never to a host-served bundle:

- **Pull** `{paths}` of the viewed host → main starts it on this Mac's daemon; the host id
  comes from the view main knows, the destination is decided by this Mac (project match or
  `~/Downloads/Eos`, Change = this Mac's native picker). The view can't name a path here.
- **Push** → this Mac's native file picker (the user's explicit pick) → into the folder the
  view is showing on its host.
- **Progress** → main forwards `transfer:change` for that host's transfers (its SSE filter
  gains `transfer:`).

Inside a host view the tab reads From = this host, To = your Mac — same components.

## Agents send files — focused sessions (phase 5)

"Save it and send it to my MacBook Air" → the agent does it.

- Tool `send_to_machine({ machine, paths })` on a **focused** session's `worker` server only:
  the registry gains `focusedDefs`, served when the session's role is focused (spawned
  workers and orchestrators don't see it). Call contract in `tool/send_to_machine.prompt.md`;
  when to use it in `role/focused/02-machines.prompt.md` (`when: { fact: role, eq: focused }`)
  — save first, send what the user asked for, don't zip, tell the user where it landed.
- It calls `POST /workers/:self/transfers` (local-only, so no other Mac can make this one
  push). The caller must be a focused session (`agentCallerOf` + its row's role), else 403.
- `machine` is matched case-insensitively against paired Macs' alias/name (a unique prefix
  is enough). No match, ambiguous or offline → the error lists the paired Macs and their
  state, so the agent can ask the user.
- **An agent never chooses where bytes land:** source = this Mac; destination =
  `~/Downloads/Eos` on the target; conflicts = Keep both, never Replace. Moving it into a
  project is the user's call (Transfer tab).
- Register-then-poll (as `ask_user`): start, then poll the transfer for up to 60 s →
  "Sent NeonDrift.app (128 MB) to MacBook Air — ~/Downloads/Eos", or "Still copying (62 %);
  it finishes in the background — progress in the Transfer tab". A transcript card follows
  the transfer live (as the memory card follows a suggestion).
- It's an ordinary transfer: Transfer tab, notifications. `policy.yaml` can make it `ask`.

## Phase 0 — cross-Mac admission (security fix)

**Cause.** The facade's `human` flag only decides whether the host's ui-token gets
attached; nothing refuses a request that isn't human. So any local process on Mac A — an
agent's `curl 127.0.0.1:7400/h/<B>/…` — reaches every route on Mac B whose handler doesn't
check the token itself:

- launch: `/fs/open` (any path or URL → `open`), `/fs/open-in`, `/fs/reveal`
- write: `/fs/paste`, `/fs/paste-b64`
- read any file: `/fs/raw/*`, `/fs/read`, `/fs/image`, `/fs/list`, `/fs/stat`, git reads —
  including `~/.ssh/*`, `~/.eos/ui-token`, `~/.eos/peer/device.key`
- steer: `POST /workers` and the command catalog, `/workers/:id/message`, settings,
  policy rules, templates

**Fix — admission at the link, not per-route patches:**

- `contracts/src/route-planes.ts` gains `PEER_OPEN_ROUTES` — public by design, nothing
  else: `GET /api/host`, `GET /ui/*` — and `isPeerOpenRoute`.
- Facade (device): a caller without this Mac's ui-token or that host's view token gets 403,
  unless the route is open. Host gateway: the same rule on `x-eos-peer-human` — the host
  holds the line even if a device skips it (an older build, a raw session).
- Requests that can't carry headers get them from the shell: each host view's session adds
  its view token to requests for that host's API/raw prefix (`webRequest.onBeforeSendHeaders`)
  — `<img>`, `<video>`, `EventSource`, pdf.js. The bundle fetch and `fetchHostInfo` hit
  open routes.
- View tokens are derived (HMAC of this Mac's ui-token + host id), not stored: an open view
  keeps its token for the app's run, so it must survive a daemon restart — otherwise the
  first restart would lock every host view out.
- The device daemon's own link calls (the notification watch) vouch for themselves.
- The local UI's `/h/` calls (`hostWorkers`, `hostPending`, `hostDecidePending`) send the
  ui-token.
- Both Macs need this build: an older device's host views lose media and live updates
  against an updated host until it updates.

Tests (`manager/peer/__tests__/peer-link.test.ts`): no token → 403 on `/fs/open`, `/fs/raw`,
`POST /workers`; view token passes only under its host; `/api/host` stays open; the gateway
refuses a non-human stream sent straight on the session.

## Phases (each ends lint + tests green, then I stop for your review)

0. **Admission fix** — above.
1. **Endpoint** — contracts schemas + ROUTES (+ `EXPECTED_KEYS`), `FsTransferEndpoint`,
   `/transfer/*` routes, `fsIgnore`, project-keys `findPath`. Tests on temp dirs: manifest
   (symlink, exec bit, mtime), offset writes + 409, commit policies, `..`/`~/.eos`/symlink
   escapes refused, free space, 412 on a changed source.
2. **Engine** — core planner/state machine, `062_transfers` + repo, `TransferService`,
   Local/Peer endpoints, `/api/transfers*` + local-only, SSE + notification. Tests: two temp
   "Macs", a reset mid-chunk resumes, pause/cancel, boot recovery, over a real in-process
   peer session.
3. **Panel** — store + components in this Mac's views. Tests: store, static-render states,
   routes parity.
4. **Host views** — `eosTransfer` bridge (main + preload), event forwarding. Tests: bridge
   withheld from host-served bundles, view can't pick a local path.
5. **Agents** — `focusedDefs`, `send_to_machine`, `/workers/:id/transfers`, the two prompt
   fragments, transcript card. Tests: registration snapshot + parity, only focused gets it,
   route refuses other roles, machine matching, destination/conflict locked, prompt render.

## Not in v1

host ⇄ host · Files panel "Send to" · dropping Finder files onto the panel · agents
choosing a destination · speed caps · checksums beyond size (TLS already guards the bytes).

## Notes

- Relay traffic crosses the relay VPS twice — big copies there are slower and use its
  bandwidth; the route line makes it visible.
- A transfer into a repo shows `.eos-incoming-<id>/` in `git status` until it commits.
- Phase 0 is what makes `/transfer/*` safe to expose: without it, "needs the host's
  ui-token" wouldn't keep an agent out of reads on the other Mac.
