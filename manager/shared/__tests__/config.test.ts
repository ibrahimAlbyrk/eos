import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// loadConfig() memoizes on first call, so we use a fresh dynamic import per
// test via the ?nocache query trick. esbuild/tsx don't honor query strings;
// instead we use the node module loader's `import.meta` cache-buster:
// reading the source file directly + parsing is overkill — just call
// loadConfig and assert behavior that doesn't depend on cache reset, plus
// one explicit cache-reset test using internal module reload.

const ENV_KEYS = [
  "CLAUDE_MGR_PORT", "CLAUDE_MGR_HOST", "CLAUDE_MGR_HOME",
  "CLAUDE_MGR_REPO_ROOT", "CLAUDE_MGR_CLAUDE_BIN", "CLAUDE_MGR_BUN_BIN",
  "CLAUDE_MGR_WORKER_PORT_START", "CLAUDE_MGR_WORKER_PORT_END",
  "CLAUDE_MGR_HEARTBEAT_MS", "CLAUDE_MGR_SHUTDOWN_GRACE_MS",
  "CLAUDE_MGR_PERMISSION_TTL_MS", "CLAUDE_MGR_SSE_KEEPALIVE_MS",
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
    delete process.env.CLAUDE_MGR_PORT;
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 7400);
  });
  it("returns 127.0.0.1 as default host", async () => {
    delete process.env.CLAUDE_MGR_HOST;
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.host, "127.0.0.1");
  });
  it("auto-detects repoRoot above shared/config.ts", async () => {
    delete process.env.CLAUDE_MGR_REPO_ROOT;
    const cfg = await freshLoad();
    // detectRepoRoot() goes two levels up from shared/config.ts ⇒ the repo root.
    assert.ok(cfg.paths.repoRoot.endsWith("claude-manager"), `unexpected repoRoot: ${cfg.paths.repoRoot}`);
  });
  it("derives workerScript from repoRoot", async () => {
    delete process.env.CLAUDE_MGR_REPO_ROOT;
    const cfg = await freshLoad();
    assert.ok(cfg.paths.workerScript.endsWith("spawner/worker.ts"));
  });
  it("seeds Anthropic-style model prices", async () => {
    const cfg = await freshLoad();
    assert.equal(cfg.prices.opus.in, 15);
    assert.equal(cfg.prices.sonnet.in, 3);
    assert.equal(cfg.prices.haiku.in, 1);
  });
});

describe("loadConfig — env overrides", () => {
  it("CLAUDE_MGR_PORT wins over default", async () => {
    process.env.CLAUDE_MGR_PORT = "9999";
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 9999);
  });
  it("ignores non-numeric port and falls back", async () => {
    process.env.CLAUDE_MGR_PORT = "not-a-number";
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.port, 7400);
  });
  it("CLAUDE_MGR_CLAUDE_BIN overrides path", async () => {
    process.env.CLAUDE_MGR_CLAUDE_BIN = "/opt/custom/claude";
    const cfg = await freshLoad();
    assert.equal(cfg.paths.claudeBin, "/opt/custom/claude");
  });
  it("worker port range respects both ends", async () => {
    process.env.CLAUDE_MGR_WORKER_PORT_START = "8000";
    process.env.CLAUDE_MGR_WORKER_PORT_END = "8010";
    const cfg = await freshLoad();
    assert.equal(cfg.worker.portRangeStart, 8000);
    assert.equal(cfg.worker.portRangeEnd, 8010);
  });
  it("CLAUDE_MGR_HOME flows to derived paths", async () => {
    process.env.CLAUDE_MGR_HOME = "/tmp/test-claude-mgr";
    const cfg = await freshLoad();
    assert.equal(cfg.daemon.home, "/tmp/test-claude-mgr");
    assert.equal(cfg.daemon.logDir, "/tmp/test-claude-mgr/logs");
    assert.equal(cfg.daemon.dbFile, "/tmp/test-claude-mgr/state.db");
    assert.equal(cfg.daemon.pidFile, "/tmp/test-claude-mgr/daemon.pid");
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
