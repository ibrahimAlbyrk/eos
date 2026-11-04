// A plugin's switches, settings and stored values, kept apart from its source
// folder (an agent rewriting the folder never touches them):
//   <root>/enabled.json          { [pluginId]: boolean }
//   <root>/<pluginId>/settings.json
//   <root>/<pluginId>/store.json { [key]: value }
// Every write replaces the file atomically.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginDataStore } from "../../../core/src/ports/Plugins.ts";

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
