import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// M2: `eos workflow status <unknownId>` must exit NON-ZERO with a clean message
// (not a raw JSON dump). We boot the real CLI as a subprocess against a fake
// daemon that 404s the run lookup — the closest honest test of the end-to-end
// exit-code + message behavior (there is no CLI unit-test seam; api() exits the
// process on HTTP error).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "..", "cli.ts"); // manager/cli.ts

let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    // The status verb does GET /workflows/:id; reply like the daemon's 404.
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "workflow run not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no server address");
  url = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

// Async spawn (NOT spawnSync): the fake daemon runs in THIS process's event
// loop, so a synchronous child would deadlock — the server could never accept the
// child's connection while spawnSync blocks.
function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CLI, ...args],
      { env: { ...process.env, EOS_URL: url } },
    );
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += String(b); });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("eos workflow status — error exit code", () => {
  it("unknown run id exits non-zero with a clean message", async () => {
    const r = await runCli(["workflow", "status", "definitely-not-a-real-run"]);
    assert.notEqual(r.code, 0, "an unknown run id must exit non-zero");
    assert.match(r.stderr, /error 404: workflow run not found/, "clean message, no raw JSON dump");
    assert.doesNotMatch(r.stderr, /\{"error"/, "the raw JSON body must not leak into the message");
  });
});
