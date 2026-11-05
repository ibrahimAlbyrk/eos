import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "../plugins/tarball.ts";
import { createPluginFetcher } from "../plugins/PluginFetchers.ts";
import { FsPluginStaging } from "../plugins/FsPluginStaging.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "eos-plugin-install-"));

// A ustar archive: [name, type ("0" file, "5" folder, "2" link), body].
function tgz(entries: Array<[string, string, string?]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, type, body = ""] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write("0000644\0", 100);
    h.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h);
    if (body) {
      const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
      data.write(body);
      blocks.push(data);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const MANIFEST = JSON.stringify({ id: "clock", name: "Clock", version: "1.2.0" });

describe("extractTarGz", () => {
  it("unpacks files and folders under package/", () => {
    const dir = tmp();
    extractTarGz(tgz([["package/", "5"], ["package/plugin.json", "0", MANIFEST], ["package/src/ui.jsx", "0", "export default 1"]]), dir);
    assert.equal(readFileSync(join(dir, "plugin.json"), "utf8"), MANIFEST);
    assert.equal(readFileSync(join(dir, "src/ui.jsx"), "utf8"), "export default 1");
  });

  it("refuses links and paths that leave the folder", () => {
    assert.throws(() => extractTarGz(tgz([["package/evil", "2"]]), tmp()), /link/);
    const dir = tmp();
    assert.throws(() => extractTarGz(tgz([["package/../../escape.txt", "0", "x"]]), join(dir, "in")), /outside/);
    assert.equal(existsSync(join(dir, "escape.txt")), false);
  });
});

describe("npm plugin fetcher", () => {
  function registry(tarball: Buffer, opts: { integrity?: string } = {}) {
    const integrity = opts.integrity ?? `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const asked: string[] = [];
    const fetch = (async (url: string) => {
      asked.push(url);
      if (url === "https://reg/eos-clock") {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "1.2.0" },
          versions: { "1.2.0": { dist: { tarball: "https://reg/eos-clock/-/eos-clock-1.2.0.tgz", integrity } } },
        }));
      }
      if (url === "https://reg/eos-clock/-/eos-clock-1.2.0.tgz") return new Response(new Uint8Array(tarball));
      return new Response("nope", { status: 404 });
    }) as typeof globalThis.fetch;
    return { fetcher: createPluginFetcher({ fetch, registry: "https://reg" }), asked };
  }

  it("downloads the tagged version, checks its integrity and unpacks it", async () => {
    const pkg = tgz([["package/plugin.json", "0", MANIFEST]]);
    const { fetcher } = registry(pkg);
    const dir = tmp();
    const got = await fetcher.fetch({ kind: "npm", name: "eos-clock" }, dir);
    assert.equal(got.resolved, "https://reg/eos-clock/-/eos-clock-1.2.0.tgz");
    assert.match(got.integrity ?? "", /^sha512-/);
    assert.equal(readFileSync(join(dir, "plugin.json"), "utf8"), MANIFEST);
  });

  it("refuses a tarball that doesn't match the registry's hash, and unknown versions", async () => {
    const pkg = tgz([["package/plugin.json", "0", MANIFEST]]);
    const bad = registry(pkg, { integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` });
    const dir = tmp();
    await assert.rejects(bad.fetcher.fetch({ kind: "npm", name: "eos-clock" }, dir), /integrity/);
    assert.deepEqual(readdirSync(dir), []);
    await assert.rejects(registry(pkg).fetcher.fetch({ kind: "npm", name: "eos-clock", version: "9.9.9" }, tmp()), /no version or tag "9.9.9"/);
    await assert.rejects(registry(pkg).fetcher.fetch({ kind: "npm", name: "missing" }, tmp()), /isn't on npm/);
  });
});

describe("local plugin fetcher", () => {
  it("copies the folder without node_modules, .git or dot-files", async () => {
    const src = tmp();
    writeFileSync(join(src, "plugin.json"), MANIFEST);
    mkdirSync(join(src, "node_modules/x"), { recursive: true });
    writeFileSync(join(src, "node_modules/x/i.js"), "");
    writeFileSync(join(src, ".env"), "SECRET=1");
    const dir = tmp();
    const got = await createPluginFetcher().fetch({ kind: "local", path: src }, dir);
    assert.deepEqual(readdirSync(dir), ["plugin.json"]);
    assert.deepEqual(got, { resolved: src, integrity: null });
  });

  it("refuses links and relative paths", async () => {
    const src = tmp();
    symlinkSync("/etc/hosts", join(src, "hosts"));
    await assert.rejects(createPluginFetcher().fetch({ kind: "local", path: src }, tmp()), /link/);
    await assert.rejects(createPluginFetcher().fetch({ kind: "local", path: "rel/dir" }, tmp()), /full path/);
  });
});

describe("FsPluginStaging", () => {
  it("promotes a stage into the plugins folder, trashing what it replaces", () => {
    const root = tmp();
    const staging = new FsPluginStaging(root, { now: () => 7 });
    mkdirSync(join(root, "clock"));
    writeFileSync(join(root, "clock/plugin.json"), "old");
    const { id, dir } = staging.create();
    writeFileSync(join(dir, "plugin.json"), MANIFEST);
    assert.deepEqual(staging.inspect(id), { manifestText: MANIFEST, topFiles: ["plugin.json"], files: 1, bytes: MANIFEST.length });
    staging.promote(id, "clock");
    assert.equal(readFileSync(join(root, "clock/plugin.json"), "utf8"), MANIFEST);
    assert.equal(readFileSync(join(root, ".trash/clock-7/plugin.json"), "utf8"), "old");
    assert.equal(staging.dir(id), null);
  });

  it("trashes a plugin, and clears stages left from before", () => {
    const root = tmp();
    const staging = new FsPluginStaging(root, { now: () => 9 });
    mkdirSync(join(root, "notes"));
    assert.equal(staging.has("notes"), true);
    staging.trash("notes");
    assert.equal(staging.has("notes"), false);
    assert.ok(existsSync(join(root, ".trash/notes-9")));
    const { id } = staging.create();
    staging.clear();
    assert.equal(staging.dir(id), null);
    assert.throws(() => staging.trash("../x"), /not a plugin id/);
  });
});
