// macOS-specific FS helpers extracted from daemon.ts. Encapsulates the
// Swift helper, sips icon conversion, and `open` shellouts. Linux/Windows
// fallbacks return null/throw — see NoopFsHelpers.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AppInfo {
  bundlePath: string;
  bundleId: string;
  appName: string;
}

export interface FsHelpers {
  pickDirectory(): Promise<string | null>;
  pickFiles(): Promise<string[] | null>;
  resolveDefaultApp(opts: { path?: string; ext?: string }): Promise<AppInfo | null>;
  iconForApp(bundlePath: string, bundleId: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
  /**
   * Returns the cached PNG path if one exists for this bundleId AND the
   * underlying icon file is on disk. Builds the icon from the cached
   * AppInfo's bundlePath if needed. Returns null only when the icon truly
   * can't be produced (non-darwin, bundle never seen, .icns missing, etc.).
   */
  iconPathForBundleId(bundleId: string): Promise<string | null>;
}

export interface DarwinFsHelpersOptions {
  helperScript: string;
  iconCacheDir: string;
  appTtlMs?: number;
}

function sanitizeBundleId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

export function createDarwinFsHelpers(opts: DarwinFsHelpersOptions): FsHelpers {
  const ttl = opts.appTtlMs ?? 60 * 60 * 1000;
  try { mkdirSync(opts.iconCacheDir, { recursive: true }); } catch {}
  // Two caches — same shapes as the old daemon.ts code.
  const cache = new Map<string, { info: AppInfo | null; expiresAt: number }>();
  const inflight = new Map<string, Promise<AppInfo | null>>();
  const iconInflight = new Map<string, Promise<string | null>>();

  function cacheKey(path: string | null, ext: string | null): string {
    if (ext) return `ext:${ext.toLowerCase()}`;
    return `path:${path}`;
  }

  async function runHelper(args: string[]): Promise<AppInfo | null> {
    if (!existsSync(opts.helperScript)) return null;
    return await new Promise<AppInfo | null>((resolve) => {
      const proc = spawn("swift", [opts.helperScript, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("exit", (code) => {
        if (code !== 0) { resolve(null); return; }
        const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
        if (lines.length < 3) { resolve(null); return; }
        resolve({ bundlePath: lines[0], bundleId: lines[1], appName: lines[2] });
      });
      proc.on("error", () => resolve(null));
    });
  }

  return {
    async pickDirectory(): Promise<string | null> {
      const out = await new Promise<string>((resolve) => {
        const proc = spawn(
          "osascript",
          ["-e", "try", "-e", 'POSIX path of (choose folder with prompt "Select project directory")', "-e", "on error", "-e", 'return ""', "-e", "end try"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let buf = "";
        proc.stdout.on("data", (d) => { buf += d.toString(); });
        proc.on("exit", () => resolve(buf.trim()));
        proc.on("error", () => resolve(""));
      });
      if (!out) return null;
      return out.endsWith("/") && out.length > 1 ? out.slice(0, -1) : out;
    },

    async pickFiles(): Promise<string[] | null> {
      const out = await new Promise<string>((resolve) => {
        const proc = spawn(
          "osascript",
          ["-e", "try", "-e", 'set f to choose file with prompt "Select files" with multiple selections allowed', "-e", "set out to \"\"", "-e", "repeat with i in f", "-e", "set out to out & POSIX path of i & \"\n\"", "-e", "end repeat", "-e", "return out", "-e", "on error", "-e", 'return ""', "-e", "end try"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let buf = "";
        proc.stdout.on("data", (d) => { buf += d.toString(); });
        proc.on("exit", () => resolve(buf.trim()));
        proc.on("error", () => resolve(""));
      });
      if (!out) return null;
      return out.split("\n").map((p) => p.trim()).filter(Boolean);
    },

    async resolveDefaultApp({ path, ext }): Promise<AppInfo | null> {
      const e = ext ?? (path && path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : null);
      const key = cacheKey(path ?? null, e ?? null);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.info;
      const flying = inflight.get(key);
      if (flying) return flying;
      let helperArgs: string[];
      if (path && existsSync(path)) helperArgs = [path];
      else if (e) helperArgs = ["--ext", e];
      else { cache.set(key, { info: null, expiresAt: Date.now() + ttl }); return null; }
      const promise = (async (): Promise<AppInfo | null> => {
        try {
          const info = await runHelper(helperArgs);
          cache.set(key, { info, expiresAt: Date.now() + ttl });
          return info;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },

    async iconForApp(bundlePath, bundleId): Promise<string | null> {
      const safe = sanitizeBundleId(bundleId || bundlePath);
      const outPath = join(opts.iconCacheDir, `${safe}.png`);
      if (existsSync(outPath)) return outPath;
      const fly = iconInflight.get(safe);
      if (fly) return fly;
      const promise = (async (): Promise<string | null> => {
        let iconName: string | null = null;
        try {
          const raw = execFileSync("defaults", ["read", join(bundlePath, "Contents", "Info"), "CFBundleIconFile"], { encoding: "utf8" });
          iconName = raw.trim() || null;
        } catch {}
        const resourcesDir = join(bundlePath, "Contents", "Resources");
        let icnsPath: string | null = null;
        if (iconName) {
          const candidate = iconName.endsWith(".icns") ? iconName : `${iconName}.icns`;
          const full = join(resourcesDir, candidate);
          if (existsSync(full)) icnsPath = full;
        }
        if (!icnsPath && existsSync(resourcesDir)) {
          try {
            const hit = readdirSync(resourcesDir).find((n) => n.toLowerCase().endsWith(".icns"));
            if (hit) icnsPath = join(resourcesDir, hit);
          } catch {}
        }
        if (!icnsPath) return null;
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("sips", ["-s", "format", "png", "-z", "64", "64", icnsPath!, "--out", outPath], { stdio: "ignore" });
          proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`sips exit ${code}`)));
          proc.on("error", reject);
        });
        return existsSync(outPath) ? outPath : null;
      })().catch(() => null);
      iconInflight.set(safe, promise);
      // On settle (success or failure), remove inflight entry. On failure the
      // promise resolved to null via .catch, so the next caller retries.
      promise.finally(() => iconInflight.delete(safe));
      return promise;
    },

    async openPath(path): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("open", [path], { stdio: "ignore" });
        proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`open exit ${code}`)));
        proc.on("error", reject);
      });
    },

    async iconPathForBundleId(bundleId): Promise<string | null> {
      const safe = sanitizeBundleId(bundleId);
      const cached = join(opts.iconCacheDir, `${safe}.png`);
      if (existsSync(cached)) return cached;
      // We don't have the bundlePath up front — pull it from the resolver
      // cache (any entry that mentions this bundleId).
      let bundlePath: string | null = null;
      for (const e of cache.values()) {
        if (e.info?.bundleId === bundleId) { bundlePath = e.info.bundlePath; break; }
      }
      if (!bundlePath) return null;
      return this.iconForApp(bundlePath, bundleId);
    },
  };
}

// Used by daemon route to read the bytes on demand.
export function readIconBytes(path: string): Buffer {
  return readFileSync(path);
}
