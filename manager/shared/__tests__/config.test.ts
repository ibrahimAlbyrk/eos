import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// loadConfig() memoizes on first call, so we use a fresh dynamic import per
// test via the ?nocache query trick. esbuild/tsx don't honor query strings;
// instead we use the node module loader's `import.meta` cache-buster:
// reading the source file directly + parsing is overkill — just call
// loadConfig and assert behavior that doesn't depend on cache reset, plus
// one explicit cache-reset test using internal module reload.

const ENV_KEYS = [
  "EOS_PORT", "EOS_HOST", "EOS_HOME",
  "EOS_REPO_ROOT", "EOS_CLAUDE_BIN", "EOS_BUN_BIN",
  "EOS_WORKER_PORT_START", "EOS_WORKER_PORT_END",
  "EOS_HEARTBEAT_MS", "EOS_SHUTDOWN_GRACE_MS",
  "EOS_PERMISSION_TTL_MS", "EOS_SSE_KEEPALIVE_MS",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Reload helper — avoids the singleton cache so each assertion sees fresh defaults.
async function freshLoad() {
  const url = new URL(`../config.ts?t=${Date.now()}-${Math.random()}`, import.meta.url);
  const mod = await import(url.href);
  return mod.loadConfig() as ReturnType<typeof import("../config.ts").loadConfig>;
}

describe("loadConfig — defaults", () => {
  it("returns 7400 as default daemon port", async () => {
    delete process.env.EOS_PORT;
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 7400);
  });
  it("returns 127.0.0.1 as default host", async () => {
    delete process.env.EOS_HOST;
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.host, "127.0.0.1");
  });
  it("auto-detects repoRoot above shared/config.ts", async () => {
    delete process.env.EOS_REPO_ROOT;
    const cfg = await freshLoad();
    // detectRepoRoot() goes two levels up from shared/config.ts ⇒ the repo root.
    const fs = await import("node:fs");
    assert.ok(fs.existsSync(`${cfg.paths.repoRoot}/manager/daemon.ts`), `unexpected repoRoot: ${cfg.paths.repoRoot}`);
  });
  it("derives workerScript from repoRoot", async () => {
    delete process.env.EOS_REPO_ROOT;
    const cfg = await freshLoad();
    assert.ok(cfg.paths.workerScript.endsWith("spawner/worker.ts"));
  });
  it("seeds Anthropic-style model prices", async () => {
    const cfg = await freshLoad();
    assert.equal(cfg.prices.opus.in, 15);
    assert.equal(cfg.prices.sonnet.in, 3);
    assert.equal(cfg.prices.haiku.in, 1);
  });
  it("seeds config.loop defaults (no budget fields)", async () => {
    // Assert the BUILT-IN defaults directly — loadConfig() would merge the live
    // ~/.eos/config.json (where a user may have toggled loop.enabled to test).
    const { defaults } = await import("../config.ts");
    const cfg = defaults();
    assert.deepEqual(cfg.loop, {
      enabled: false,            // ships behind an explicit opt-in
      maxAttempts: null,         // unbounded by default — netted only by no-progress
      strategy: "hybrid",
      noProgressWindow: 3,
      stopOnNoProgress: true,
      retryOnFailed: false,
      judge: { model: "sonnet", temperature: 0.1 },
    });
    // budget was removed — these must never reappear
    assert.equal("maxTokens" in cfg.loop, false);
    assert.equal("maxWallClockMs" in cfg.loop, false);
  });
  it("seeds config.workflow defaults", async () => {
    const { defaults } = await import("../config.ts");
    const cfg = defaults();
    assert.deepEqual(cfg.workflow, {
      enabled: true,
      maxConcurrentSteps: 8,
      defaultStepTimeoutMs: 0,
      defaultScriptTimeoutMs: 30000,
    });
  });
});

describe("loadConfig — env overrides", () => {
  it("EOS_PORT wins over default", async () => {
    process.env.EOS_PORT = "9999";
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 9999);
  });
  it("ignores non-numeric port and falls back", async () => {
    process.env.EOS_PORT = "not-a-number";
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 7400);
  });
  it("EOS_CLAUDE_BIN overrides path", async () => {
    process.env.EOS_CLAUDE_BIN = "/opt/custom/claude";
    const cfg = await freshLoad();
    assert.equal(cfg.paths.claudeBin, "/opt/custom/claude");
  });
  it("worker port range respects both ends", async () => {
    process.env.EOS_WORKER_PORT_START = "8000";
    process.env.EOS_WORKER_PORT_END = "8010";
    const cfg = await freshLoad();
    assert.equal(cfg.worker.portRangeStart, 8000);
    assert.equal(cfg.worker.portRangeEnd, 8010);
  });
  it("EOS_HOME flows to derived paths", async () => {
    process.env.EOS_HOME = "/tmp/test-eos";
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.home, "/tmp/test-eos");
    assert.equal(cfg.daemon.logDir, "/tmp/test-eos/logs");
    assert.equal(cfg.daemon.dbFile, "/tmp/test-eos/state.db");
    assert.equal(cfg.daemon.pidFile, "/tmp/test-eos/daemon.pid");
  });
});

describe("loadConfig — memoization", () => {
  it("second call without reset returns the same object reference", async () => {
    const { loadConfig } = await import("../config.ts");
    const a = loadConfig();
    const b = loadConfig();
    assert.equal(a, b);
  });
});

describe("DaemonConfigOverrideSchema — Zod validation", () => {
  let tmpHome: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    tmpHome = (process.env.TMPDIR ?? "/tmp") + `/cfg-test-${Date.now()}-${Math.random()}`;
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.EOS_HOME = tmpHome;
  });
  afterEach(async () => {
    delete process.env.EOS_HOME;
    try {
      const fs = await import("node:fs");
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it("valid partial override is accepted", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpHome, "config.json"), JSON.stringify({ daemon: { port: 8000 } }));
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 8000);
  });

  it("invalid type is rejected and defaults apply", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpHome, "config.json"), JSON.stringify({ daemon: { port: "not a number" } }));
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 7400);
  });

  it("partial config.workflow override field-merges over the defaults", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpHome, "config.json"), JSON.stringify({ workflow: { maxConcurrentSteps: 3 } }));
    const cfg = await freshLoad();
    assert.equal(cfg.workflow.maxConcurrentSteps, 3);
    assert.equal(cfg.workflow.enabled, true);          // untouched default preserved
    assert.equal(cfg.workflow.defaultStepTimeoutMs, 0); // untouched default preserved
  });

  it("partial override leaves other fields at defaults", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpHome, "config.json"), JSON.stringify({ daemon: { host: "0.0.0.0" } }));
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.host, "0.0.0.0");
    assert.equal(cfg.daemon.port, 7400);
    assert.ok(cfg.paths.repoRoot.length > 0);
  });

  // Regression: shallow-merge used to wipe other ModelPrice fields when a
  // partial price override was supplied, yielding NaN cost downstream.
  it("partial price override preserves other price fields", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(
      path.join(tmpHome, "config.json"),
      JSON.stringify({ prices: { sonnet: { in: 4.5 } } }),
    );
    const cfg = await freshLoad();
    assert.equal(cfg.prices.sonnet.in, 4.5);
    assert.equal(cfg.prices.sonnet.out, 15);
    assert.equal(cfg.prices.sonnet.cacheRead, 0.30);
    assert.equal(cfg.prices.sonnet.cacheCreate, 3.75);
    assert.equal(cfg.prices.sonnet.cacheCreate1h, 6);
    assert.equal(cfg.prices.opus.in, 15);
  });

  it("full price override replaces all values", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(
      path.join(tmpHome, "config.json"),
      JSON.stringify({ prices: { haiku: { in: 2, out: 8, cacheRead: 0.2, cacheCreate: 2.5, cacheCreate1h: 4 } } }),
    );
    const cfg = await freshLoad();
    assert.equal(cfg.prices.haiku.in, 2);
    assert.equal(cfg.prices.haiku.out, 8);
    assert.equal(cfg.prices.haiku.cacheRead, 0.2);
    assert.equal(cfg.prices.haiku.cacheCreate, 2.5);
    assert.equal(cfg.prices.haiku.cacheCreate1h, 4);
  });

  // Regression: `backends` wraps the contracts-side BackendProfileSchema in a
  // manager-side z.record(). The 2-arg z.record(z.string(), Schema) detects its
  // overload via `instanceof ZodType`, which fails across separate physical zod
  // copies (manager/ vs contracts/) and silently collapsed the value type to
  // string — so a valid object profile was rejected as "expected string" and
  // the whole config was dropped. The 1-arg z.record(Schema) form fixes it.
  it("backend profile override (object value) is accepted, not collapsed to string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(
      path.join(tmpHome, "config.json"),
      JSON.stringify({
        backends: {
          "claude-sdk": {
            kind: "claude-sdk", model: "opus",
            auth: { kind: "subscription" }, costMode: "included",
            params: { thinking: { type: "adaptive", display: "summarized" } },
          },
        },
        defaults: { orchestrator: { backend: "claude-sdk" }, worker: { backend: "claude-sdk" } },
      }),
    );
    const cfg = await freshLoad();
    assert.equal(cfg.backends["claude-sdk"]?.kind, "claude-sdk");
    assert.equal(cfg.backends["claude-sdk"]?.model, "opus");
    assert.equal(cfg.defaults.orchestrator.backend, "claude-sdk");
    assert.equal(cfg.defaults.worker.backend, "claude-sdk");
    // Built-in claude-cli profiles still present (per-profile merge, not replace).
    assert.ok(cfg.backends["claude-cli-opus"]);
  });
});
