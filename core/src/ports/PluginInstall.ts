// Plugin install ports: fetching a plugin from where it is published, the
// staging area an install waits in, and the record of where each installed
// plugin came from. The PluginInstaller (core/services) drives them; adapters
// live in infra/src/plugins.

import type { PluginInstallRecord, PluginSource } from "../../../contracts/src/plugin-install.ts";

export interface FetchedPlugin {
  readonly resolved: string;
  readonly integrity: string | null;
}

export interface PluginFetcher {
  // Puts the plugin's files into `dir` (an empty folder) without running any of
  // them. Throws an Error whose message is meant for the user.
  fetch(source: PluginSource, dir: string): Promise<FetchedPlugin>;
}

export interface StagedFolder {
  readonly manifestText: string | null;
  // Top-level file names, for finding the default UI entry.
  readonly topFiles: readonly string[];
  readonly files: number;
  readonly bytes: number;
}

export interface PluginStaging {
  // A new, empty folder for one install.
  create(): { id: string; dir: string };
  dir(id: string): string | null;
  inspect(id: string): StagedFolder;
  discard(id: string): void;
  // Drops every staged install (left over from before a restart).
  clear(): void;
  // Moves a staged folder in as plugin `pluginId`, all or nothing; the plugin
  // already there (if any) goes to the trash.
  promote(id: string, pluginId: string): void;
  // Moves plugin `pluginId`'s folder to the trash.
  trash(pluginId: string): void;
  // A plugin folder exists for this id.
  has(pluginId: string): boolean;
}

export interface PluginInstallStore {
  all(): Record<string, PluginInstallRecord>;
  get(id: string): PluginInstallRecord | null;
  set(id: string, record: PluginInstallRecord): void;
  remove(id: string): void;
}
