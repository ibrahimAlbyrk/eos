// Plugin folders on disk: one per plugin under `root` (~/.eos/plugins), watched
// recursively so any edit inside a folder reports that plugin's id.

import chokidar from "chokidar";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { PluginFolder, PluginWorkspace } from "../../../core/src/ports/Plugins.ts";
import { PLUGIN_MANIFEST_FILE } from "../../../contracts/src/plugin.ts";

// Never part of a plugin's own source; watching them would only add noise.
const IGNORED = /(^|[/\\])(node_modules|\.git|dist)([/\\]|$)|(^|[/\\])\.[^/\\]*$/;

export class FsPluginWorkspace implements PluginWorkspace {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  list(): PluginFolder[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => this.read(d.name))
      .filter((f): f is PluginFolder => f !== null);
  }

  read(id: string): PluginFolder | null {
    if (!id || id.startsWith(".") || id.includes("/") || id.includes("\\")) return null;
    const dir = join(this.root, id);
    try {
      if (!statSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
    let manifestText: string | null = null;
    try {
      manifestText = readFileSync(join(dir, PLUGIN_MANIFEST_FILE), "utf8");
    } catch {}
    return { id, dir, manifestText, files: readdirSync(dir) };
  }

  watch(onChange: (id: string) => void): () => void {
    mkdirSync(this.root, { recursive: true });
    const watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (p: string) => IGNORED.test(relative(this.root, p)),
      depth: 6,
    });
    const report = (p: string) => {
      const id = relative(this.root, p).split(sep)[0];
      if (id && !id.startsWith(".")) onChange(id);
    };
    watcher.on("all", (_event, p) => report(p));
    return () => { void watcher.close(); };
  }
}
