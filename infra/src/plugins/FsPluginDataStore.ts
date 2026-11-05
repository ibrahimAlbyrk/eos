// A plugin's switches, settings and stored values, kept apart from its source
// folder (an agent rewriting the folder never touches them):
//   <root>/enabled.json          { [pluginId]: boolean }
//   <root>/<pluginId>/settings.json
//   <root>/<pluginId>/store.json { [key]: value }
//   <root>/installed.json        { [pluginId]: where it was installed from }
// Every write replaces the file atomically.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginDataStore } from "../../../core/src/ports/Plugins.ts";
import type { PluginInstallStore } from "../../../core/src/ports/PluginInstall.ts";
import { PluginInstallRecordSchema, type PluginInstallRecord } from "../../../contracts/src/plugin-install.ts";

export class FsPluginDataStore implements PluginDataStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  enabled(): Record<string, boolean> {
    return readJson(join(this.root, "enabled.json"));
  }

  setEnabled(id: string, on: boolean): void {
    writeJson(join(this.root, "enabled.json"), { ...this.enabled(), [id]: on });
  }

  settings(id: string): Record<string, unknown> {
    return readJson(join(this.root, id, "settings.json"));
  }

  setSettings(id: string, values: Record<string, unknown>): void {
    writeJson(join(this.root, id, "settings.json"), values);
  }

  storeValue(id: string, key: string): unknown {
    return readJson(join(this.root, id, "store.json"))[key];
  }

  setStoreValue(id: string, key: string, value: unknown): void {
    const file = join(this.root, id, "store.json");
    const all = readJson(file);
    if (value === undefined || value === null) delete all[key];
    else all[key] = value;
    writeJson(file, all);
  }
}

export class FsPluginInstallStore implements PluginInstallStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = join(root, "installed.json");
  }

  all(): Record<string, PluginInstallRecord> {
    const out: Record<string, PluginInstallRecord> = {};
    for (const [id, raw] of Object.entries(readJson(this.file))) {
      const r = PluginInstallRecordSchema.safeParse(raw);
      if (r.success) out[id] = r.data;
    }
    return out;
  }

  get(id: string): PluginInstallRecord | null {
    return this.all()[id] ?? null;
  }

  set(id: string, record: PluginInstallRecord): void {
    writeJson(this.file, { ...readJson(this.file), [id]: record });
  }

  remove(id: string): void {
    const all = readJson(this.file);
    delete all[id];
    writeJson(this.file, all);
  }
}

function readJson(file: string): Record<string, any> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
