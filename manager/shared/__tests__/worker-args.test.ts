import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { buildWorkerArgs, type BuildWorkerArgsInput } from "../worker-args.ts";

const WORKER_SCRIPT = "/x/worker.ts";

function baseInput(spec: BuildWorkerArgsInput["spec"]): BuildWorkerArgsInput {
  return {
    id: "w1",
    port: 7421,
    model: "opus",
    spec,
    workerScript: WORKER_SCRIPT,
    daemonPort: 7400,
    worker: {
      heartbeatMs: 1,
      heartbeatQuietMs: 1,
      shutdownGraceMs: 1,
      ptyWriteDelayMs: 1,
    },
  };
}

// Mirrors spawner/options.ts so the round-trip test exercises the real parser.
const PARSE_OPTIONS = {
  cwd: { type: "string" },
  prompt: { type: "string" },
  name: { type: "string" },
  "worktree-from": { type: "string" },
  branch: { type: "string" },
  "keep-worktree": { type: "boolean", default: false },
  "with-gateway": { type: "boolean", default: false },
  port: { type: "string", default: "7421" },
  "daemon-url": { type: "string" },
  "worker-id": { type: "string" },
  persistent: { type: "boolean", default: false },
  "system-prompt-file": { type: "string" },
  "mcp-config": { type: "string" },
  "permission-prompt-tool": { type: "string" },
  "claude-permission-mode": { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  "parent-id": { type: "string" },
  "heartbeat-ms": { type: "string" },
  "heartbeat-quiet-ms": { type: "string" },
  "shutdown-grace-ms": { type: "string" },
  "pty-write-delay-ms": { type: "string" },
  "readiness-fallback-ms": { type: "string" },
  "readiness-settle-ms": { type: "string" },
  "prompt-ack-window-ms": { type: "string" },
} as const;

function postScriptSlice(args: string[]): string[] {
  return args.slice(args.indexOf(WORKER_SCRIPT) + 1);
}

describe("buildWorkerArgs", () => {
  it("encodes dash-leading values as a single attached '=' token", () => {
    const args = buildWorkerArgs(
      baseInput({ prompt: "- task1", cwd: "/tmp/x", branch: "-x", name: "-foo" }),
    );

    assert.ok(args.includes("--prompt=- task1"));
    assert.ok(args.includes("--branch=-x"));
    assert.ok(args.includes("--name=-foo"));

    assert.equal(args.indexOf("--prompt"), -1);
    assert.equal(args.indexOf("--branch"), -1);
    assert.equal(args.indexOf("--name"), -1);
  });

  it("round-trips dash-leading values through strict parseArgs without throwing", () => {
    const args = buildWorkerArgs(
      baseInput({ prompt: "- task1", cwd: "/tmp/x", branch: "-x", name: "-foo" }),
    );

    const slice = postScriptSlice(args);
    const { values } = parseArgs({ args: slice, options: PARSE_OPTIONS, strict: true });

    assert.equal(values.prompt, "- task1");
    assert.equal(values.branch, "-x");
    assert.equal(values.name, "-foo");
  });

  it("keeps ordinary prompts round-tripping and boolean/fixed flags bare", () => {
    const args = buildWorkerArgs(
      baseInput({ prompt: "do the thing", cwd: "/tmp/x", withGateway: true, persistent: true }),
    );

    const slice = postScriptSlice(args);
    const { values } = parseArgs({ args: slice, options: PARSE_OPTIONS, strict: true });
    assert.equal(values.prompt, "do the thing");

    assert.ok(args.includes("--with-gateway"));
    assert.ok(args.includes("--persistent"));
    assert.equal(args.indexOf("--with-gateway=true"), -1);
    assert.equal(args.indexOf("--persistent=true"), -1);

    assert.ok(args.includes("--experimental-strip-types"));
    assert.ok(args.includes("--no-warnings"));
    assert.ok(args.includes(WORKER_SCRIPT));
  });
});
