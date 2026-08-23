import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rotateIfLarge } from "../../log-rotate.ts";

const dir = mkdtempSync(join(tmpdir(), "eos-logrotate-"));
const logPath = join(dir, "daemon.log");

function write(path: string, body: string): void { writeFileSync(path, body); }

describe("rotateIfLarge", () => {
  beforeEach(() => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("does nothing when the file is absent", () => {
    assert.equal(rotateIfLarge(logPath, 10, 3), false);
  });

  it("does nothing while the file is under the limit", () => {
    write(logPath, "small");
    assert.equal(rotateIfLarge(logPath, 100, 3), false);
    assert.equal(readFileSync(logPath, "utf8"), "small");
  });

  it("moves an oversized log to .1", () => {
    write(logPath, "x".repeat(50));
    assert.equal(rotateIfLarge(logPath, 10, 3), true);
    assert.equal(existsSync(logPath), false);
    assert.equal(readFileSync(`${logPath}.1`, "utf8").length, 50);
  });

  it("shifts older generations up and drops the oldest", () => {
    write(logPath, "new".repeat(20));
    write(`${logPath}.1`, "gen1");
    write(`${logPath}.2`, "gen2");
    write(`${logPath}.3`, "gen3-oldest");
    rotateIfLarge(logPath, 10, 3);
    assert.equal(readFileSync(`${logPath}.1`, "utf8"), "new".repeat(20));
    assert.equal(readFileSync(`${logPath}.2`, "utf8"), "gen1");
    assert.equal(readFileSync(`${logPath}.3`, "utf8"), "gen2");
    // gen3 fell off the end — keep=3 is the whole budget.
    assert.equal(existsSync(`${logPath}.4`), false);
  });
});
