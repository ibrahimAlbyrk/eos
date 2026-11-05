// Fetches a plugin's files from where it is published, running none of them:
//   npm   — the registry's tarball, checked against the registry's sha512
//           integrity hash, unpacked by hand. No `npm install`: no install
//           scripts, no dependencies — a plugin package carries its own files.
//   git   — a shallow https clone with hooks off and no submodules; the commit
//           it landed on is what gets recorded. The .git folder is dropped.
//   local — a copy of a folder on this Mac (node_modules, .git and dot-files left out).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { FetchedPlugin, PluginFetcher } from "../../../core/src/ports/PluginInstall.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import type { PluginSource } from "../../../contracts/src/plugin-install.ts";
import { PACKAGE_LIMITS, extractTarGz } from "./tarball.ts";

const run = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 60_000;
const SKIPPED = new Set(["node_modules", ".git"]);

export interface PluginFetcherDeps {
  readonly fetch?: typeof fetch;
  readonly registry?: string;
  readonly git?: string;
}

export function createPluginFetcher(deps: PluginFetcherDeps = {}): PluginFetcher {
  const http = deps.fetch ?? fetch;
  const registry = deps.registry ?? REGISTRY;
  const git = deps.git ?? "git";
  return {
    fetch: (source, dir) => {
      if (source.kind === "npm") return fetchNpm(source, dir);
      if (source.kind === "git") return fetchGit(source, dir);
      return fetchLocal(source, dir);
    },
  };

  async function fetchNpm(source: Extract<PluginSource, { kind: "npm" }>, dir: string): Promise<FetchedPlugin> {
    const meta = await getJson(`${registry}/${source.name.replace("/", "%2f")}`, source.name) as {
      "dist-tags"?: Record<string, string>;
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
    };
    const wanted = source.version ?? "latest";
    const version = meta["dist-tags"]?.[wanted] ?? wanted;
    const dist = meta.versions?.[version]?.dist;
    if (!dist?.tarball) throw new ValidationError(`${source.name} has no version or tag "${wanted}"`);
    const integrity = dist.integrity ?? "";
    const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.split(/\s+/).find((h) => h.startsWith("sha512-")) ?? "");
    if (!m) throw new ValidationError(`${source.name}@${version} has no sha512 integrity hash on the registry — not installing it`);
    if (!dist.tarball.startsWith("https://")) throw new ValidationError(`${source.name}@${version}'s tarball isn't served over https`);
    const tgz = await getBytes(dist.tarball, `${source.name}@${version}`);
    if (createHash("sha512").update(tgz).digest("base64") !== m[1]) {
      throw new ValidationError(`${source.name}@${version} doesn't match the registry's integrity hash — not installing it`);
    }
    try {
      extractTarGz(tgz, dir);
    } catch (e) {
      throw new ValidationError(`${source.name}@${version}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { resolved: dist.tarball, integrity: `sha512-${m[1]}` };
  }

  async function fetchGit(source: Extract<PluginSource, { kind: "git" }>, dir: string): Promise<FetchedPlugin> {
    // Hooks off even if the user's git config names a hooks folder, and no templates.
    const noHooks = mkdtempSync(join(tmpdir(), "eos-plugin-hooks-"));
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" };
      const args = [
        "-c", `core.hooksPath=${noHooks}`, "-c", "core.symlinks=false",
        "clone", "--depth", "1", "--single-branch", "--no-tags", `--template=${noHooks}`,
        ...(source.ref ? ["--branch", source.ref] : []),
        "--", source.url, dir,
      ];
      await run(git, args, { env, timeout: TIMEOUT_MS }).catch((e: { stderr?: string; message?: string }) => {
        throw new ValidationError(`couldn't clone ${source.url}${source.ref ? ` at ${source.ref}` : ""}: ${(e.stderr || e.message || "").trim()}`);
      });
      const { stdout } = await run(git, ["-C", dir, "rev-parse", "HEAD"], { env, timeout: TIMEOUT_MS });
      const commit = stdout.trim();
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      checkSize(dir, source.url);
      return { resolved: commit, integrity: `git:${commit}` };
    } finally {
      rmSync(noHooks, { recursive: true, force: true });
    }
  }

  async function getJson(url: string, what: string): Promise<unknown> {
    const res = await request(url, what, { accept: "application/vnd.npm.install-v1+json" });
    return res.json();
  }

  async function getBytes(url: string, what: string): Promise<Uint8Array> {
    const res = await request(url, what);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > PACKAGE_LIMITS.bytes) throw new ValidationError(`${what} is too big for a plugin`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > PACKAGE_LIMITS.bytes) throw new ValidationError(`${what} is too big for a plugin`);
    return bytes;
  }

  async function request(url: string, what: string, headers: Record<string, string> = {}): Promise<Response> {
    let res: Response;
    try {
      res = await http(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    } catch (e) {
      throw new ValidationError(`couldn't reach the npm registry for ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) throw new ValidationError(`${what} isn't on npm`);
    if (!res.ok) throw new ValidationError(`the npm registry answered ${res.status} for ${what}`);
    return res;
  }
}

async function fetchLocal(source: Extract<PluginSource, { kind: "local" }>, dir: string): Promise<FetchedPlugin> {
  if (!isAbsolute(source.path)) throw new ValidationError(`${source.path} isn't a full path`);
  let st;
  try {
    st = statSync(source.path);
  } catch {
    throw new ValidationError(`${source.path} doesn't exist`);
  }
  if (!st.isDirectory()) throw new ValidationError(`${source.path} isn't a folder`);
  let files = 0;
  let bytes = 0;
  const copy = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (SKIPPED.has(e.name) || e.name.startsWith(".")) continue;
      const src = join(from, e.name);
      if (lstatSync(src).isSymbolicLink()) throw new ValidationError(`${src} is a link — not allowed in a plugin`);
      if (e.isDirectory()) { copy(src, join(to, e.name)); continue; }
      if (!e.isFile()) continue;
      files++;
      bytes += statSync(src).size;
      if (files > PACKAGE_LIMITS.files || bytes > PACKAGE_LIMITS.bytes) throw new ValidationError(`${source.path} is too big for a plugin`);
      copyFileSync(src, join(to, e.name));
    }
  };
  copy(source.path, dir);
  return { resolved: source.path, integrity: null };
}

function checkSize(dir: string, what: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; bytes += lstatSync(p).size; }
      if (files > PACKAGE_LIMITS.files || bytes > PACKAGE_LIMITS.bytes) throw new ValidationError(`${what} is too big for a plugin`);
    }
  };
  walk(dir);
}
