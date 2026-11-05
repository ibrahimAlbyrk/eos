// Where an install waits for review, and how it moves in: under the plugins
// folder (`root`, ~/.eos/plugins) in dot-folders the plugin watcher ignores —
//   .staging/<stagingId>/   a fetched plugin (regenerable: cleared at start)
//   .trash/<id>-<time>/     a replaced or removed plugin (kept, never deleted)

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PluginStaging, StagedFolder } from "../../../core/src/ports/PluginInstall.ts";
import { PLUGIN_MANIFEST_FILE } from "../../../contracts/src/plugin.ts";

export class FsPluginStaging implements PluginStaging {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly trashRoot: string;
  private readonly now: () => number;

  constructor(root: string, opts: { now?: () => number } = {}) {
    this.root = root;
    this.stagingRoot = join(root, ".staging");
    this.trashRoot = join(root, ".trash");
    this.now = opts.now ?? Date.now;
  }

  create(): { id: string; dir: string } {
    const id = `st-${randomBytes(6).toString("hex")}`;
    const dir = join(this.stagingRoot, id);
    mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  dir(id: string): string | null {
    const dir = join(this.stagingRoot, id);
    return /^st-[a-z0-9]+$/.test(id) && existsSync(dir) ? dir : null;
  }

  inspect(id: string): StagedFolder {
    const dir = this.mustDir(id);
    let files = 0;
    let bytes = 0;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.isFile()) { files++; bytes += statSync(join(d, e.name)).size; }
      }
    };
    walk(dir);
    let manifestText: string | null = null;
    try {
      manifestText = readFileSync(join(dir, PLUGIN_MANIFEST_FILE), "utf8");
    } catch {}
    return { manifestText, topFiles: readdirSync(dir), files, bytes };
  }

  discard(id: string): void {
    const dir = this.dir(id);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  clear(): void {
    rmSync(this.stagingRoot, { recursive: true, force: true });
  }

  promote(id: string, pluginId: string): void {
    const from = this.mustDir(id);
    const target = this.pluginDir(pluginId);
    const replaced = existsSync(target) ? this.toTrash(pluginId) : null;
    try {
      renameSync(from, target);
    } catch (e) {
      // Put the old one back: all or nothing.
      if (replaced) renameSync(replaced, target);
      throw e;
    }
  }

  trash(pluginId: string): void {
    this.toTrash(pluginId);
  }

  has(pluginId: string): boolean {
    try {
      return lstatSync(this.pluginDir(pluginId)).isDirectory();
    } catch {
      return false;
    }
  }

  private toTrash(pluginId: string): string {
    mkdirSync(this.trashRoot, { recursive: true });
    const to = join(this.trashRoot, `${pluginId}-${this.now()}`);
    renameSync(this.pluginDir(pluginId), to);
    return to;
  }

  private pluginDir(pluginId: string): string {
    if (!pluginId || pluginId.startsWith(".") || /[/\\]/.test(pluginId)) throw new Error(`not a plugin id: ${pluginId}`);
    return join(this.root, pluginId);
  }

  private mustDir(id: string): string {
    const dir = this.dir(id);
    if (!dir) throw new Error(`no staged install ${id}`);
    return dir;
  }
}
