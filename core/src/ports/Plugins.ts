// Plugin ports: where plugin folders live, how a UI entry is built, and where a
// plugin's switches, settings and stored values are kept. The PluginService
// (core/services) drives them; adapters live in infra/src/plugins.

export interface PluginFolder {
  // The folder's name — a plugin's manifest id must match it.
  readonly id: string;
  readonly dir: string;
  // plugin.json's text, or null when the folder has none.
  readonly manifestText: string | null;
  // Top-level file names, for finding the default UI entry.
  readonly files: readonly string[];
}

export interface PluginWorkspace {
  list(): PluginFolder[];
  read(id: string): PluginFolder | null;
  // Calls back with the id of every plugin folder that changed (added, edited,
  // removed). Returns the function that stops watching.
  watch(onChange: (id: string) => void): () => void;
}

export interface PluginBuild {
  readonly js: string;
  readonly css: string | null;
}

export interface PluginBuilder {
  // Throws an Error whose message is meant for whoever wrote the plugin.
  build(dir: string, entry: string): Promise<PluginBuild>;
}

export interface PluginDataStore {
  enabled(): Record<string, boolean>;
  setEnabled(id: string, on: boolean): void;
  settings(id: string): Record<string, unknown>;
  setSettings(id: string, values: Record<string, unknown>): void;
  storeValue(id: string, key: string): unknown;
  setStoreValue(id: string, key: string, value: unknown): void;
}
