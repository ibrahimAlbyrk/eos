import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelCatalogService } from "../ModelCatalogService.ts";
import type { CatalogModel } from "../../../contracts/src/http.ts";

const MODEL_A: CatalogModel = {
  id: "claude-opus-4-8",
  displayName: "Claude Opus 4.8",
  createdAt: "2026-05-28T00:00:00Z",
  maxInputTokens: 1_000_000,
  maxTokens: 128_000,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
};
const MODEL_B: CatalogModel = {
  id: "claude-haiku-4-5-20251001",
  displayName: "Claude Haiku 4.5",
  createdAt: "2025-10-01T00:00:00Z",
  maxInputTokens: 200_000,
  maxTokens: 64_000,
  effortLevels: [],
};

function fakeClock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("ModelCatalogService", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "model-catalog-test-"));
    file = join(dir, "models.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetches and writes cache on first run", async () => {
    const clock = fakeClock(1000);
    const svc = new ModelCatalogService(file, clock, async () => [MODEL_A, MODEL_B]);
    assert.deepEqual(await svc.get(), [MODEL_A, MODEL_B]);
    const disk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(disk.fetchedAt, 1000);
    assert.equal(disk.models.length, 2);
  });

  it("returns empty list when first fetch fails", async () => {
    const svc = new ModelCatalogService(file, fakeClock(0), async () => {
      throw new Error("offline");
    });
    assert.deepEqual(await svc.get(), []);
    assert.equal(existsSync(file), false);
  });

  it("serves disk cache without fetching when fresh", async () => {
    writeFileSync(file, JSON.stringify({ fetchedAt: 1000, models: [MODEL_A] }));
    let calls = 0;
    const svc = new ModelCatalogService(file, fakeClock(2000), async () => {
      calls++;
      return [MODEL_B];
    });
    assert.deepEqual(await svc.get(), [MODEL_A]);
    assert.equal(calls, 0);
  });

  it("refreshes in background when cache is stale", async () => {
    writeFileSync(file, JSON.stringify({ fetchedAt: 0, models: [MODEL_A] }));
    const clock = fakeClock(7 * 60 * 60 * 1000);
    let resolveFetch!: (m: CatalogModel[]) => void;
    const svc = new ModelCatalogService(file, clock, () => new Promise((r) => { resolveFetch = r; }));
    assert.deepEqual(await svc.get(), [MODEL_A]); // stale copy served immediately
    resolveFetch([MODEL_B]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(await svc.get(), [MODEL_B]);
  });

  it("keeps stale cache when background refresh fails", async () => {
    writeFileSync(file, JSON.stringify({ fetchedAt: 0, models: [MODEL_A] }));
    const svc = new ModelCatalogService(file, fakeClock(7 * 60 * 60 * 1000), async () => {
      throw new Error("offline");
    });
    assert.deepEqual(await svc.get(), [MODEL_A]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(await svc.get(), [MODEL_A]);
  });

  it("ignores empty fetch results", async () => {
    const svc = new ModelCatalogService(file, fakeClock(0), async () => []);
    assert.deepEqual(await svc.get(), []);
    assert.equal(existsSync(file), false);
  });

  it("falls back to fetch on corrupt cache file", async () => {
    writeFileSync(file, "{not json");
    const svc = new ModelCatalogService(file, fakeClock(0), async () => [MODEL_A]);
    assert.deepEqual(await svc.get(), [MODEL_A]);
  });

  it("parses a pre-upgrade cache without effortLevels as unknown (null)", async () => {
    const { effortLevels: _ignored, ...legacy } = MODEL_A;
    writeFileSync(file, JSON.stringify({ fetchedAt: 1000, models: [legacy] }));
    const svc = new ModelCatalogService(file, fakeClock(2000), async () => []);
    assert.deepEqual(await svc.get(), [{ ...legacy, effortLevels: null }]);
    assert.equal(await svc.effortLevelsFor("opus"), null);
  });

  it("resolves effort levels by exact id, family alias, and id prefix", async () => {
    const svc = new ModelCatalogService(file, fakeClock(0), async () => [MODEL_A, MODEL_B]);
    assert.deepEqual(await svc.effortLevelsFor("claude-opus-4-8"), MODEL_A.effortLevels);
    assert.deepEqual(await svc.effortLevelsFor("opus"), MODEL_A.effortLevels);
    assert.deepEqual(await svc.effortLevelsFor("haiku"), []);
    assert.deepEqual(await svc.effortLevelsFor("claude-haiku-4-5"), []); // dated id via prefix
    assert.equal(await svc.effortLevelsFor("gpt-5"), null); // unknown → fail open
  });

  it("family alias resolves to the newest member", async () => {
    const older: CatalogModel = {
      ...MODEL_A,
      id: "claude-opus-4-6",
      createdAt: "2025-11-01T00:00:00Z",
      effortLevels: ["low", "medium", "high", "max"],
    };
    const svc = new ModelCatalogService(file, fakeClock(0), async () => [older, MODEL_A]);
    assert.deepEqual(await svc.effortLevelsFor("opus"), MODEL_A.effortLevels);
    assert.deepEqual(await svc.effortLevelsFor("claude-opus-4-6"), older.effortLevels);
  });
});
