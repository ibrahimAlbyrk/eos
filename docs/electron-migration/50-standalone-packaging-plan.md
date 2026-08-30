# 50 — Standalone Packaging Plan

Making the packaged Eos app boot the daemon on a machine with **no repo checkout
and no system `node`/`bun`**.

Status: originally a feasibility pass; implementation is now underway in stages.
Every claim below is grounded in the code with `path:line`. **See §12 (Stage log)
for the operator's decisions and executed-stage results — those OVERRIDE the
recommendations in §0/§10 where they differ (notably: FULL LANES, not SDK-only).**

---

## 0. TL;DR / recommended architecture

Ship the daemon as a **single esbuild bundle** and run it with **Electron's own
Node** (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) — no separate `node`, no
`--experimental-strip-types` (esbuild strips types at build time).

The one decision that unlocks everything: **support only the `claude-sdk` lane in
the packaged app.** The SDK lane runs entirely in-process in the daemon
(`manager/backends/sdk/ClaudeSdkBackend.ts`), routing permissions through the
in-process `canUseTool → PolicyGatewayService` bridge (`ClaudeSdkBackend.ts:404`,
`manager/backends/sdk/SdkPermissionBridge.ts`). That means the packaged daemon
spawns **none** of the separate-process TypeScript entrypoints:

- no `spawner/worker.ts` (PTY worker) → **node-pty native module dropped**
- no `gateway/server.ts` (Bun) → **Bun dropped entirely**
- no `manager/worker-mcp.ts` / `manager/orchestrator-mcp.ts` subprocesses → MCP
  tools are hosted in-process (`SdkToolHost`, `RuntimeMcpClient`)

What the packaged app must still ship:

1. the **daemon bundle** (2.6 MB, one `.mjs`),
2. `@anthropic-ai/claude-agent-sdk` **+ its platform `claude` binary** (~214 MB,
   arm64) — the SDK spawns this compiled binary at runtime; unavoidable,
3. `web-tree-sitter` + `@vscode/tree-sitter-wasm` (WASM, ~25 MB) for the symbol
   index — kept **external** because they resolve `.wasm` assets at runtime,
4. the DPI prompt library `manager/prompts/` (472 KB) and default worker
   definitions `manager/workers/` (16 KB).

SQLite needs **no native module**: the daemon uses built-in `node:sqlite`
(`DatabaseSync`), and Electron 42.10.1 bundles **Node v24.15.0**, where
`node:sqlite` is stable/unflagged.

Realistic size delta: **~+246 MB per arch** on top of the current `app/out`
(452 MB), dominated by the 214 MB `claude` binary.

---

## 1. Daemon runtime process / dependency graph

### 1.1 Separate OS processes the daemon can spawn today

`ORPHAN_PATTERN` (the pkill set the lifecycle uses to reap orphans) is the
authoritative list of process entrypoints — `manager/cli/daemon-lifecycle.ts:16`:

```
manager/daemon.ts | spawner/worker.ts | orchestrator-mcp.ts | worker-mcp.ts | gateway/server.ts | claude --settings
```

| Process | Entry | Runtime today | Spawned by (path:line) | Lane |
|---|---|---|---|---|
| Daemon | `manager/daemon.ts` | `node --experimental-strip-types` | `manager/cli/daemon-lifecycle.ts:156`; app: `app/src/main/daemon.ts:188` | both |
| PTY worker | `spawner/worker.ts` | `node` (uses node-pty) | `infra/src/supervision/ChildProcessSupervisor.ts:28` ← `manager/backends/ClaudeCliBackend.ts:113`; argv in `manager/shared/worker-args.ts:29` | claude-cli only |
| Worker MCP | `manager/worker-mcp.ts` | `node` (stdio MCP) | claude CLI inside the worker PTY, via synthetic mcp.json (`spawner/claude-args.ts:23`) | claude-cli only |
| Orchestrator MCP | `manager/orchestrator-mcp.ts` | `node` (stdio MCP) | claude CLI inside the orchestrator PTY, via mcp.json (`manager/container.ts:545`) | claude-cli only |
| Gateway | `gateway/server.ts` | **`bun run`** (stdio MCP) | claude CLI inside the PTY, via mcp.json (`spawner/claude-args.ts:54`); script path from `manager/container.ts:506,549` | claude-cli only |
| `claude` binary | SDK-bundled exe | standalone (self-contained) | `@anthropic-ai/claude-agent-sdk` `query()` (`manager/backends/sdk/ClaudeSdkBackend.ts:451`) | claude-sdk |
| Chrome | system Chrome | Chromium | `infra/src/browser/CdpBrowserAdapter.ts:156` ← `manager/services/BrowserService.ts` | both (optional) |

### 1.2 The lane split is the whole game

- **`claude-cli` lane** (the original PTY lane) is what needs `spawner/worker.ts`
  (node-pty), the two `*-mcp.ts` subprocesses, and the Bun `gateway/server.ts`.
- **`claude-sdk` lane** (the default per CLAUDE.md) runs **in-process** in the
  daemon. It hosts Eos tools in-process (`manager/backends/sdk/SdkToolHost.ts`)
  and makes every permission decision through the in-process bridge
  `canUseTool: makeCanUseTool(spec.workerId, deps.policy)`
  (`ClaudeSdkBackend.ts:404`), i.e. the same `PolicyGatewayService` the daemon's
  `/policy/decide` route calls — **it never launches `gateway/server.ts`.**

The only external process the SDK lane needs is the `claude` binary itself
(spawned by the SDK), plus optional Chrome for the browser tools.

### 1.3 Backend selection / fallback

- Default backend is `claude-sdk`; the DB defaults `backendKind` to `claude-cli`
  only when unspecified on insert (`infra/src/persistence/SqliteWorkerRepo.ts:108`).
- `manager/shared/spawn-backend.ts:65` falls back to `claude-cli` (PTY) when the
  in-process subscription lane has **no OAuth credential**. For a packaged
  SDK-only build this fallback must become a **hard error** ("sign in first")
  rather than a silent drop to a lane we no longer ship (see M2).

---

## 2. Native / binary / WASM inventory

| Dependency | Kind | Used by (path:line) | Ship? |
|---|---|---|---|
| `node:sqlite` (`DatabaseSync`) | **built-in** | `infra/src/persistence/*.ts` (e.g. `SqliteEventRepo.ts:12`, `MigrationRunner.ts:11`) | nothing to ship — needs Node ≥ 22.5 (Electron 42 = Node 24.15 ✓) |
| `@homebridge/node-pty-prebuilt-multiarch` | **native `.node`** | `spawner/worker.ts:12`, `spawner/pty-host.ts:13` → `manager/services/PtySessionService.ts:3` | **drop** (SDK-only). Installed tree has Linux prebuilds only + a locally-compiled `build/Release/pty.node`; a Mac build would need `electron-rebuild` against Electron ABI 146 — avoided by dropping. |
| `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` | JS wrapper + **214 MB compiled exe** | `manager/backends/sdk/ClaudeSdkBackend.ts:14,451`; declared `manager/package.json:13`; platform pkgs are optionalDependencies of the SDK | **ship** (external node_modules; binary `asarUnpack`-ed) |
| `web-tree-sitter` (4.4 MB) + `@vscode/tree-sitter-wasm` (21 MB, 18 grammars) | **WASM** | `infra/src/symbols/TreeSitterSymbolIndex.ts:97` uses `createRequire(import.meta.url)` to resolve the wasm dir at runtime | **ship** (external; keep as node_modules so runtime path resolution finds the `.wasm`) |
| `chokidar` v4 | pure JS | infra/spawner | bundled (no fsevents needed; chokidar 4 dropped it) |
| `fsevents` | native | only in `manager/`+`app/ui` transitive dev trees, **not** in the daemon runtime path | not shipped |
| `ws`, `yaml`, `zod`, `@modelcontextprotocol/sdk` | pure JS | daemon | bundled |

**No `process.dlopen` / eval-require** anywhere in `infra|core|spawner|gateway`;
the only `createRequire` is the tree-sitter wasm dir resolver above.

---

## 3. Dry esbuild bundle attempt (actually run)

Tooling present: `manager/node_modules/.bin/esbuild` **0.28.0**, and
`app/node_modules/esbuild` 0.28.2. The app already bundles its main/preload with
esbuild (`app/esbuild.mjs`, `platform:node target:node24 format:cjs external:electron`).

Driver: `esbuild build({ entryPoints:["manager/daemon.ts"], bundle:true,
platform:"node", format:"esm", target:"node22", metafile:true, logLimit:0,
banner: createRequire shim })`.

### 3.1 Results

**Pass 1 — no externals → 1 error.** esbuild has no loader for `.node`:

```
ERROR: No loader is configured for ".node" files:
  spawner/node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node
  (via .../lib/prebuild-loader.js:10)
```

This confirms the daemon **transitively imports node-pty** — not through the
worker lane, but through the **terminal-pane feature**:
`manager/container.ts:605` builds `PtySessionService` → `spawner/pty-host.ts` →
node-pty. So dropping node-pty means removing that feature too (see M2), not just
declining the claude-cli lane.

**Pass 2 — `external:[node-pty]` only → 0 errors, 0 warnings, 3.8 MB.** esbuild
happily bundled the SDK wrapper and the tree-sitter JS. But that is misleading:
the SDK resolves its `claude` binary via `require.resolve` and tree-sitter
resolves `.wasm` via `createRequire(import.meta.url)` — both break when the code
lives inside a single relocated bundle. They must stay external for **runtime**
correctness even though they bundle without a **build** error.

**Pass 3 (recommended) — `external:[node-pty, @anthropic-ai/claude-agent-sdk,
web-tree-sitter, @vscode/tree-sitter-wasm]` → 0 errors, 0 warnings, 2.6 MB.**
857 inputs (463 from node_modules) collapse into one `daemon.bundle.mjs`. Static
external imports left in the output: `@anthropic-ai/claude-agent-sdk`,
`web-tree-sitter`, `@homebridge/node-pty-prebuilt-multiarch` (the last only
because the feature is still present in this dry run;
`@vscode/tree-sitter-wasm` doesn't appear as a static import — it's the runtime
`createRequire` resolve). `node:` builtins referenced include **`node:sqlite`**,
`node:http`, `node:crypto`, `node:net`, `node:module`, `node:fs`, etc. — all
present in Electron's Node 24.15.

### 3.2 What bundles cleanly vs. must stay external

- **Bundles cleanly:** all of `manager/` (routes, services, container), `core/`,
  `infra/` (incl. all `node:sqlite` persistence), `contracts/`, and pure-JS deps
  (`ws`, `yaml`, `zod`, `@modelcontextprotocol/sdk`, `chokidar`). `.ts`-extension
  import specifiers resolve fine; top-level statements are fine in ESM output.
- **Must stay external (ship as node_modules next to the bundle):**
  `@anthropic-ai/claude-agent-sdk` (+ platform binary), `web-tree-sitter`,
  `@vscode/tree-sitter-wasm`.
- **Dropped, not shipped:** `@homebridge/node-pty-prebuilt-multiarch` (remove the
  import site, M2).
- **Separate-process entries** (`spawner/worker.ts`, `manager/worker-mcp.ts`,
  `manager/orchestrator-mcp.ts`, `gateway/server.ts`): **not bundled and not
  shipped** in the SDK-only build — they belong to the claude-cli lane. (If the
  claude-cli lane is ever wanted in a package, each needs its own bundle +
  the gateway ported to Node — see §5 / Decision A.)

---

## 4. Gateway (Bun) — the fork, resolved

Independent finding: **`gateway/server.ts` and all its imports use ZERO
Bun-specific APIs.** It's an MCP stdio server (`@modelcontextprotocol/sdk`) using
only `zod`, `node:fs/os/path`, `fetch`, `process.*`. The only Bun-ism is a
*conditional* `init.unix = socketPath` fetch option in
`gateway/DaemonProxyPolicy.ts:26,35` that Node silently ignores (graceful TCP
fallback). Bun is used **purely as a `.ts` runtime** (direct `.ts` imports +
top-level await). `AuditLog` persists JSONL to `~/.eos/audit.jsonl` via
`node:fs.appendFileSync`.

The three options the brief asked me to weigh:

- **(a) Port the gateway to Node** — trivial (zero Bun APIs). But in the SDK-only
  build it's **moot**: the gateway process is never spawned.
- **(b) `bun build --compile` to a standalone exe in Resources** — ~55–90 MB, and
  still only needed by the claude-cli lane.
- **(c) Ship the full Bun binary (~90 MB) and spawn `bun`** — largest, no upside.

**Recommendation: none of the above for the standalone app — drop the Bun gateway
process entirely.** The gateway's decision logic already runs in-process for the
SDK lane via `PolicyGatewayService` / `SdkPermissionBridge`. Bun disappears from
the shipped app. (If Decision A later re-includes the claude-cli lane, take
option **(a)** — port to Node — never (b)/(c).)

---

## 5. Claude binary + OAuth (SDK lane)

- **The `claude` binary MUST be shipped.** The SDK spawns a compiled `claude`
  executable (`ClaudeSdkBackend.ts:451`; SDK `Options.pathToClaudeCodeExecutable`
  defaults to the built-in). Eos never sets `pathToClaudeCodeExecutable`, so the
  SDK auto-resolves `@anthropic-ai/claude-agent-sdk-<platform>/claude` via
  `require.resolve`. Installed binary:
  `manager/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
  (**214 MB**). It is self-contained (its own JS runtime) — needs no external
  node/bun. Note: `config.paths.claudeBin` (`manager/shared/config.ts:341`,
  default `"claude"`) feeds only the **claude-cli** lane; the SDK lane ignores it.
- **OAuth resolution** (`infra/src/auth/SubscriptionAuthResolver.ts:22-48`),
  injected into the SDK child via `manager/backends/sdk/billing-env.ts:36-50` as
  `CLAUDE_CODE_OAUTH_TOKEN`:
  1. macOS **Keychain** generic-password `"Claude Code-credentials"` (via
     `security find-generic-password -w`), expiry-checked;
  2. `~/.claude/.credentials.json` (`claudeAiOauth.accessToken` or root `accessToken`);
  3. env `CLAUDE_CODE_OAUTH_TOKEN`;
  4. `~/.eos/config.json` `anthropic.authToken` overrides all.

  Nothing is shipped; the credential is user-managed. **Risk:** a differently
  code-signed Eos.app reading the Keychain item created by the `claude` CLI may
  hit a Keychain ACL prompt/denial — verify, and rely on (2)/(3) as fallback.

---

## 6. Path resolution when `app.isPackaged`

Dev today: `resolveRepoRoot()` = `path.dirname(app.getAppPath())`
(`app/src/main/daemon.ts:43`), and the daemon entry is
`<repoRoot>/manager/daemon.ts` (`daemon.ts:188`). Packaged there is no repo.

Good news: the daemon already reads path overrides from **env**, so the app can
inject them at spawn time rather than patching many sites:

- `EOS_REPO_ROOT` (`manager/shared/config.ts:325`, else `detectRepoRoot()` via
  `import.meta.url` at ~`config.ts:204`),
- `EOS_PROMPTS_DIR`, `EOS_WORKER_DEFINITIONS_DIR` (defaults
  `join(repoRoot,"manager","prompts"|"workers")`, `config.ts:344-345`),
- `EOS_GATEWAY_SCRIPT` (`container.ts:506`) — irrelevant in SDK-only mode.

Sites that must become packaged-aware:

1. `app/src/main/daemon.ts:43` `resolveRepoRoot()` → `process.resourcesPath` when
   `app.isPackaged`.
2. `app/src/main/daemon.ts:177-193` `spawnDaemon()` → launch
   **`process.execPath` with `ELECTRON_RUN_AS_NODE=1`** and the **bundle path**
   (`Resources/daemon/daemon.bundle.mjs`), dropping `--experimental-strip-types`;
   set `EOS_REPO_ROOT`/`EOS_PROMPTS_DIR`/`EOS_WORKER_DEFINITIONS_DIR` =
   `process.resourcesPath` subdirs. Keep the `ulimit -Sn` bump (still wrap in
   `/bin/bash -c 'ulimit …; exec "$ELECTRON" …'`).
3. `manager/shared/config.ts` `detectRepoRoot()` — when `EOS_REPO_ROOT` is set
   (it will be), `import.meta.url` walking is bypassed; ensure that precedence
   holds so the asar path is never walked.

---

## 7. Recommended bundling architecture

```
Eos.app/Contents/Resources/
  app.asar                     # electron main/preload (existing) + ui/dist
  daemon/
    daemon.bundle.mjs          # esbuild bundle of manager/daemon.ts (2.6 MB)
    node_modules/
      @anthropic-ai/claude-agent-sdk/            # JS wrapper
      @anthropic-ai/claude-agent-sdk-darwin-arm64/claude   # 214 MB (asarUnpack / on real fs, +x, signed)
      web-tree-sitter/          # + .wasm
      @vscode/tree-sitter-wasm/ # 18 grammar .wasm
  prompts/                     # from manager/prompts (472 KB)
  workers/                     # from manager/workers defaults (16 KB)
```

- Run: `process.execPath` + `ELECTRON_RUN_AS_NODE=1 daemon/daemon.bundle.mjs`.
- The external node_modules must be resolvable from the bundle's directory
  (place them at `Resources/daemon/node_modules/`). The compiled `claude` binary
  must live on the **real filesystem** (not inside asar) and be executable +
  codesigned; use Forge `extraResource` + `asarUnpack` (or keep the whole
  `daemon/` tree as `extraResource`, which is already outside asar).

---

## 8. Ordered implementation plan (milestones + verification gates)

Each gate is a command that can be run **without touching the live dev daemon**
(use a throwaway `EOS_HOME=$(mktemp -d)` for any boot smoke test).

- **M0 — Gate check (½ day).** Confirm `node:sqlite` exists under Electron's Node:
  `ELECTRON_RUN_AS_NODE=1 <electron> -e "require('node:sqlite');console.log('ok')"`.
  Confirm `ELECTRON_RUN_AS_NODE` runs a plain script. **Gate:** both print ok.
- **M1 — Daemon bundle (1–2 days).** Add `manager/esbuild.daemon.mjs` (format esm,
  externals = SDK + web-tree-sitter + @vscode/tree-sitter-wasm; createRequire
  banner). **Gate:** bundle builds 0 errors; then boot it under a temp
  `EOS_HOME` via `ELECTRON_RUN_AS_NODE` and `curl /health` → 200. (Re-run the
  §3.1 pass-3 build as the CI check.)
- **M2 — SDK-only slimming (1–2 days).** Remove/guard the node-pty import site:
  `PtySessionService` (`container.ts:605`), `routes/pty.ts`, `spawner/pty-host.ts`
  usage; don't register `createClaudeCliBackend`; turn the no-credential
  `spawn-backend.ts:65` PTY fallback into a hard "sign in" error. **Gate:**
  daemon bundle builds & boots with **no** node-pty on disk; `npm run lint` +
  `cd manager && npm test` green.
- **M3 — Packaged path + spawn (1 day).** Implement `app.isPackaged` branches
  (§6). **Gate:** dev run unaffected (`cd app && npm start` still adopts/spawns);
  packaged dry check that the spawn argv points at the bundle + sets env.
- **M4 — Forge packaging (1–2 days).** `extraResource` the `daemon/` tree,
  prompts, workers; `asarUnpack` the `claude` binary; ensure +x. **Gate:**
  `cd app && npm run package` produces `Eos.app`; manual launch on a clean
  machine/VM with no repo and no system node/bun boots the daemon and the UI
  loads.
- **M5 — Auth + first-run (1 day).** Verify OAuth resolution in the packaged,
  signed app (Keychain ACL vs. `~/.claude/.credentials.json` vs.
  `CLAUDE_CODE_OAUTH_TOKEN`). **Gate:** a worker spawns and streams in the
  packaged app.
- **M6 — Signing/notarization + arch (2–3 days).** Hardened-runtime entitlements
  for the `claude` exe (likely `allow-jit` / `allow-unsigned-executable-memory`);
  per-arch builds (arm64 / x64) to avoid doubling the 214 MB binary. **Gate:**
  `spctl`/notarization pass; app launches from `/Applications` unquarantined.

---

## 9. App-size delta (measured)

| Item | Size |
|---|---|
| current `app/out` (Electron + Chromium + ui) | 452 MB |
| daemon bundle | 2.6 MB |
| `@anthropic-ai/claude-agent-sdk` wrapper | 3.5 MB |
| `claude` binary (darwin-arm64) | **214 MB** |
| `@vscode/tree-sitter-wasm` + `web-tree-sitter` | 25 MB |
| `manager/prompts` + `manager/workers` | ~0.5 MB |
| **standalone delta (per arch)** | **~+246 MB → ~700 MB total** |

Universal (both arch `claude` binaries) would add another ~214 MB → recommend
**per-arch** DMGs. Dropping the symbol index (tree-sitter) would save ~25 MB at
the cost of go-to-definition / find-references.

---

## 10. DECISIONS NEEDED FROM OPERATOR

- **A. Lanes in the packaged app.** *Recommend: SDK-only.* This drops Bun,
  node-pty, and all three separate-process entrypoints — by far the smallest,
  simplest, most reliable bundle. **Cost:** the packaged app loses the
  interactive **terminal panes** (`/pty` + `PtySessionService`), the **claude-cli
  PTY worker lane**, and **rewind** (double-Esc replay, PTY-only). If any of those
  are must-haves, we instead keep node-pty (adds `electron-rebuild` against
  Electron ABI 146 + native codesigning) and port `gateway/server.ts` to Node.
- **B. Gateway.** *Recommend: drop the Bun gateway process* (moot in SDK-only;
  logic already in-process). If A re-adds claude-cli, *port to Node* (zero Bun
  APIs) — do **not** ship the Bun binary or `bun build --compile`.
- **C. Claude binary / arch.** Shipping the 214 MB `claude` binary is
  unavoidable with the SDK. *Recommend: per-arch builds* (arm64 + x64 separately)
  rather than a universal app that doubles it.
- **D. Browser tools.** *Recommend: don't bundle Chrome* (~+150 MB). Use system
  Chrome via `config.browser.chromePath`; the browser feature degrades gracefully
  when Chrome is absent. Confirm that's acceptable.
- **E. Symbol index.** Keep `web-tree-sitter` + grammars (~25 MB) for
  go-to-definition/find-references, or drop to slim the app? *Recommend: keep.*

---

## 11. Risks / unknowns

- **`node:sqlite` under Electron's Node build (HIGH).** Node 24.15 has it stable,
  but Electron can compile Node built-ins in/out. Must verify with the M0 gate
  before committing to the bundle. Fallback if absent: switch the SQLite adapter
  to `better-sqlite3` (native, `electron-rebuild`, ship prebuilt per arch) — a
  meaningful detour.
- **Keychain ACL for OAuth (MED).** The `"Claude Code-credentials"` item is
  created by the `claude` CLI; a differently-signed Eos.app calling `security`
  may prompt or be denied. Fallbacks (`~/.claude/.credentials.json`,
  `CLAUDE_CODE_OAUTH_TOKEN`) mitigate; verify in M5.
- **Notarizing the 214 MB `claude` exe (MED).** It's a self-contained JS-runtime
  binary; hardened runtime likely needs JIT entitlements. Unknown until M6.
- **Hidden dynamic imports (LOW).** esbuild reported 0 warnings across 857 inputs,
  but a runtime-constructed `import()` could still surface only at boot — the M1
  boot-smoke gate is the guard.
- **`ELECTRON_RUN_AS_NODE` + child env (LOW).** The SDK spawns `claude`; confirm
  the OAuth env + `cwd` propagate through the run-as-node parent.
- **Prompts/worker-definitions drift (LOW).** These become shipped read-only
  Resources; first-run must still seed the user-writable `~/.eos/templates` &
  `~/.eos/workers` without clobbering (respect the `user-data.ts` manifest).

---

## 12. Stage log (executed)

### Operator decisions (override §0/§10 where they differ)

- **FULL LANES** — keep terminal panes, the claude-cli PTY lane, and rewind. So
  the packaged app ships the claude-cli lane too: **port the gateway to Node**
  (zero Bun APIs → run on Electron's Node, don't drop it), **ship node-pty** as a
  prebuilt native binary, and **bundle/ship** the separate-process entries
  (`spawner/worker.ts`, `manager/worker-mcp.ts`, `manager/orchestrator-mcp.ts`,
  gateway).
- **Drop the Bun runtime** (gateway runs on Node). **arm64-only** for now
  (universal later). **System Chrome** (don't bundle Chromium). **Keep** the
  tree-sitter symbol index. **Ship** the `claude` binary.

Net effect on this plan: §10-A = full lanes; §10-B = port gateway to Node (not
drop); node-pty is **kept** (not dropped as in §0/§5/M2) and must be rebuilt for
Electron's ABI + shipped. The daemon-bundle and Electron-node-runtime spine
(§0/§3/§6/§7) is unchanged.

### Stage 1 — M0 + M1 (done)

- **M0 — `node:sqlite` gate: PASS.** Electron 42.10.1 runs **Node 24.18.1**
  (module ABI 146). `require('node:sqlite')` + `DatabaseSync(':memory:')` create/
  insert/select all work. Exact invocation:
  `ELECTRON_RUN_AS_NODE=1 app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <script>`.
- **M1a — daemon bundle: PASS.** `app/scripts/bundle-daemon.mjs` (esbuild, ESM,
  target node24, externals = node-pty + claude-agent-sdk + web-tree-sitter +
  @vscode/tree-sitter-wasm, createRequire banner) → `app/.forge-build/daemon/
  daemon.bundle.mjs`, **2.57 MB, 0 errors, 0 warnings** (output gitignored).
- **M1b — boot-smoke: PASS.** Bundled daemon launched via Electron-node with a
  throwaway `HOME`/`EOS_HOME` and spare ports (7455 API / 7456 raw / 7600-7650
  workers), externals symlinked next to the bundle. Result: `GET /health` →
  `{"ok":true,...}`; SQLite `state.db` created with **57 migrations applied +
  VACUUM** (proves `node:sqlite` end-to-end in the real daemon); raw + unix
  socket also bound — all inside the temp home. Smoke daemon killed by its own
  pid; temp home + symlink `node_modules` removed. All four externals (incl.
  node-pty at ABI 146) loaded without error under Electron-node.
- **Live daemon:** real pid is **797** (`~/.eos/daemon.pid`), listening on
  127.0.0.1:7400 — healthy and untouched (the earlier "pid 2276" reference was
  stale; 2276 was not running and was never signalled). Nothing written to the
  real `~/.eos`.

### Open items feeding Stage 2

- **Gateway → Node:** esbuild-bundle `gateway/server.ts` (mirrors the daemon
  bundle) and launch it via Electron-node instead of `bun run …`
  (`spawner/claude-args.ts:54`, `container.ts:549`). The lone Bun-ism
  (`fetch(..,{unix})` in `DaemonProxyPolicy.ts:35`) degrades to TCP on Node
  (fine for local 127.0.0.1) or gets a `http.request({socketPath})` path.
- **node-pty shipping:** loads under Electron ABI 146 on this machine, but the
  package build must use `@electron/rebuild` for reproducibility + `asarUnpack`.
- **Separate-process launch:** the daemon supervisor spawns workers with binary
  `"node"` (`container.ts:235`); packaged mode must switch to `process.execPath`
  + `ELECTRON_RUN_AS_NODE=1` and bundle `worker.ts` / `worker-mcp.ts` /
  `orchestrator-mcp.ts`; the claude-cli lane's `EOS_CLAUDE_BIN` must point at the
  shipped SDK `claude` binary.

### Operator decision update (post-Stage 1): FULL LANES

Keep everything (terminal panes, claude-cli PTY lane, rewind). So node-pty is
KEPT and shipped (not dropped), the gateway is PORTED to Node (not dropped), and
all separate-process entries are bundled/shipped. Bun runtime dropped (gateway
runs on Electron's Node). arm64-only for now. System Chrome. Keep tree-sitter.

### Stage 2 — M2 (bundle subprocess entries + node-pty) + M3 (packaged resolution) (done)

Central gate: `EOS_PACKAGED=1` (set by the Electron main when it spawns the
daemon). New `manager/shared/packaging.ts` resolves nodeBin / run-env / ts-flags
/ entry paths; every packaged branch is a no-op in dev, so the dev/live daemon is
byte-identical.

- **All 5 backend bundles build** via `app/scripts/bundle-daemon.mjs` (0 errors,
  0 warnings, no new externals): daemon 2.57 MB, gateway 0.82, worker 0.25,
  worker-mcp 1.23, orchestrator-mcp 1.23 → `app/.forge-build/daemon/` (gitignored).
- **Gateway on Node.** The lone Bun-ism (`fetch{unix}`) is replaced by
  `node:http.request({socketPath})` in `DaemonProxyPolicy.ts` — verified to work
  on **both** Bun (dev gateway) and Electron-node (packaged). Smoke: the bundled
  gateway on Electron-node in daemon-proxy mode reached the daemon's
  `/policy/decide` over the unix socket and returned `allow`.
- **Packaged spawn/resolution (gated).** `config.paths.{workerScript,gatewayScript,
  workerMcpScript,orchestratorMcpScript}` resolve to bundles when packaged, repo
  `.ts` in dev; supervisor binary = `nodeBin()`; `buildEnv` adds
  `ELECTRON_RUN_AS_NODE`; container MCP builtins + `spawner/claude-args.ts` switch
  command/flags on packaged; `app/src/main/daemon.ts` `resolveRepoRoot` →
  `process.resourcesPath` and `spawnDaemon` → Electron-node + bundle + `EOS_*`
  env (incl. `EOS_CLAUDE_BIN` = shipped SDK binary) when `app.isPackaged`.
- **node-pty:** `forge.config.js` `asar:{unpack:"**/*.node"}` + `rebuildConfig`
  (onlyModules node-pty, force). Loads under Electron ABI 146 in the worker.bundle
  smoke.
- **Verify:** app `tsc --noEmit` clean; root `npm run lint` 0 errors; manager
  config+worker-args+builder+backends suites 77/77 pass; packaged boot-smoke =
  5/5 (packaged daemon `/health` + SQLite; gateway decide; worker-mcp 18 tools;
  orchestrator-mcp 30 tools; worker.bundle loads). Live daemon **797** untouched;
  nothing written to real `~/.eos`. (Pre-existing unrelated failure:
  `manager/shared/__tests__/http.test.ts` — imports none of the changed files.)

### Stage 3 — M4 (assemble + package) + M5 (OAuth) + E2E + M6 (sign config) (done)

- **Assembly.** `app/scripts/assemble-daemon.mjs` copies the runtime closure into
  `app/.forge-build/daemon/node_modules` — SDK + `claude-agent-sdk-darwin-arm64`
  (214 MB), node-pty, web-tree-sitter, `@vscode/tree-sitter-wasm` (closures are
  trivial: SDK deps `{}`, node-pty's deps are build-time only, tree-sitter zero-dep)
  — prunes node-pty's Linux prebuilds, writes a minimal `package.json`, then runs
  `@electron/rebuild` (v42.10.1, arm64, node-pty) = **ok**. `forge.config.js`
  prePackage runs bundle+assemble; `extraResource` ships `daemon/`, `prompts/`,
  `workers/`; the `daemon/` subtree is excluded from `app.asar` (ships loose).
- **Package.** `cd app && npm run package` → `app/out/Eos-darwin-arm64/Eos.app`,
  **583 MB** (214 MB is the claude binary). `app.asar` = 48 KB (daemon tree NOT
  duplicated). `claude` + `pty.node` present, executable, on the real fs. Info.plist:
  id `com.ibrahimalbyrk.eos`, name/exec `Eos`. **Not opened** (id collides with the
  running native Eos.app + would adopt live daemon 797).
- **OAuth (M5) — no code change; proven by the E2E.** The packaged daemon runs as
  the logged-in user; `spawnDaemon` inherits the real env and does NOT override
  `HOME`, so `SubscriptionAuthResolver` (`infra/src/auth/SubscriptionAuthResolver.ts`)
  and the `claude` binary resolve the subscription creds exactly as in dev:
  macOS **Keychain** `"Claude Code-credentials"` → `~/.claude/.credentials.json`
  (present here, 0600) → `CLAUDE_CODE_OAUTH_TOKEN` env. **Signed-app Keychain-ACL
  caveat:** a newly Developer-ID-signed Eos.app is a different code identity than
  the `claude` CLI that created the Keychain item, so first access may prompt the
  user (or be denied ad-hoc). `~/.claude/.credentials.json` and
  `CLAUDE_CODE_OAUTH_TOKEN` are the prompt-free fallbacks.
- **END-TO-END (PASS).** Booted the daemon from the built `app/out` Resources via
  Electron-node (throwaway `EOS_HOME`, real `HOME`, spare ports 7455/7456,
  workers 7710-7730, `EOS_PACKAGED=1`, `EOS_CLAUDE_BIN`=shipped binary), then
  `POST /workers {backendKind:"claude-cli", withGateway:true, model:"haiku"}` with
  a nonce-transform prompt. The worker (worker.ts + node-pty) spawned the shipped
  claude binary, authenticated, and the assistant produced the uppercased nonce
  `EOS-PKG-LIVE-7Q` (the prompt only contained it lowercase) — proving
  daemon→gateway→worker→claude-binary→OAuth end-to-end in the packaged build.
  Daemon+worker reaped by scoped pid kills; temp home removed; live 797 alive.
- **M6 (config + docs only, NOT executed — no cert).** `forge.config.js` already
  gates `osxSign` (hardenedRuntime) + `osxNotarize` (Apple API key env) + the DMG
  maker (`EOS_DMG=1`). Added `build/entitlements.claude.plist` (allow-jit +
  allow-unsigned-executable-memory + disable-library-validation) and made
  `optionsForFile` apply it to the bundled `claude` binary while the app/native
  addon keep the strict `entitlements.mac.plist`.
- **Verify:** app `tsc` clean; root lint 0 errors; manager 77/77; E2E PASS. Live
  daemon **797** untouched throughout; nothing written to real `~/.eos`.

### Operator steps left (out-of-session)

1. **Sign + notarize (needs a Developer ID):**
   `EOS_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAMID>)"`,
   `EOS_APPLE_API_KEY=<.p8 path> EOS_APPLE_API_KEY_ID=<id> EOS_APPLE_API_ISSUER=<issuer>`,
   then `cd app && EOS_DMG=1 npm run make` (arm64) → signed+notarized `.app` + DMG in
   `app/out/`. If notarization rejects the `claude` binary, tighten/loosen
   `entitlements.claude.plist` and re-run. (Install `@electron-forge/maker-dmg` if absent.)
2. **Real GUI launch test (only after the native Eos.app is quit — shared bundle id):**
   quit the old `/Applications/Eos.app`, then open the packaged app and confirm it
   SPAWNS its own daemon (splash → window) rather than adopting one; check
   `~/.eos/logs/daemon.log` shows the `EOS_PACKAGED` daemon.
3. **Daemon-spawn path test:** with no daemon running, launch the packaged app; it
   should boot the bundled daemon via `process.execPath` + `ELECTRON_RUN_AS_NODE`
   and reach a healthy window. (Both of these are the operator's box; they were
   NOT run in-session because the GUI would collide with the live fleet.)

### Stage 4 — Dock-icon fix + `eos build --app` installer (done)

**Root cause of "no Dock icon / no app presence."** Without a Developer ID cert,
Forge did no signing, so the packaged app kept Electron's linker-signed default,
whose code-signature `Identifier` is the generic **`Electron`** (not the bundle
id) — `codesign -dv` showed `Identifier=Electron`, `flags=0x20002(adhoc,
linker-signed)`. LaunchServices can't resolve an app whose signing identity is
the generic `Electron` string, so it registered a **NULL bundleID** and gave the
app no Dock icon. Info.plist itself was already correct (`CFBundleIdentifier=
com.ibrahimalbyrk.eos`, `LSUIElement` unset, icon present) — the defect was
purely the code-signature identifier.

**Durable fix (`app/forge.config.js` `postPackage` hook).** When no
`EOS_SIGNING_IDENTITY` is set, re-sign the packaged app ad-hoc:
`codesign --force --deep --sign - <app>` — **no** global `--identifier`. With
`--deep`, codesign defaults each bundle's identifier to its OWN
`CFBundleIdentifier`: top-level → `com.ibrahimalbyrk.eos`, helpers →
`com.ibrahimalbyrk.eos.helper`, Electron Framework → its own. (Passing
`--identifier com.ibrahimalbyrk.eos` with `--deep` is WRONG — it stamps that one
id onto every nested helper/framework, causing identifier collisions.) The hook
is skipped when a real identity is set (osxSign already produced a proper
Developer ID signature, also keyed to `CFBundleIdentifier`). Verified on a fresh
`cd app && npm run package`: `codesign -dv` `Identifier=Electron` → **`Identifier=
com.ibrahimalbyrk.eos`**; `codesign --verify --deep --strict` passes.

**`eos build --app` — build + install the desktop app.** `eos build` stays
deps+daemon only; the new opt-in `--app` flag (`manager/cli/commands/build.ts` →
`manager/builder/app-install.ts`) runs, AFTER the converge, the destructive
install sequence: `npm --prefix app run package` (Forge bundles+assembles the
daemon, postPackage ad-hoc-signs) → verify the built app's signature
`Identifier == com.ibrahimalbyrk.eos` → **quit** the running `Eos.app` +
`stopDaemonAndOrphans(pidFile)` (reused from the daemon lifecycle) → `rm -rf
/Applications/Eos.app` → `ditto <built> /Applications/Eos.app` (preserves the
signature + xattrs) → `lsregister -f /Applications/Eos.app` → `killall Dock` →
`open`. It is gated behind `--app` because it replaces the running app and
restarts its daemon, **ending the current session**. `eos build --app --dry-run`
previews every command (including the build) and executes NONE — the safe way to
inspect the path. arm64-only (`Eos-darwin-${process.arch}`), darwin-guarded.

**Immediate one-liner for the CURRENTLY-installed app (no rebuild).** The live
`/Applications/Eos.app` still shows `Identifier=Electron`; to fix its Dock icon
without rebuilding, the operator runs (⚠️ the re-sign needs the app **QUIT** —
re-signing a running bundle is unreliable, and this quits the daemon backing any
live session):

```bash
# 1. Quit Eos (ends any session backed by it), THEN:
codesign --force --deep --sign - /Applications/Eos.app   # Identifier=Electron → com.ibrahimalbyrk.eos
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f /Applications/Eos.app
killall Dock
open /Applications/Eos.app
```

`lsregister -f … && killall Dock` **alone** (no quit, no re-sign) may not suffice:
LaunchServices still reads the generic `Electron` identity, so the re-sign is the
part that actually fixes identity. Going forward, apps built by the Stage-4 hook
are correct at package time and need none of this.
