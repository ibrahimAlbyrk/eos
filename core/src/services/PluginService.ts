// PluginService — the one owner of plugin state. It keeps every plugin folder
// in step with its built UI: a folder changing on disk rebuilds that plugin and
// announces the new revision, which every window loads in place of the old one.
// A failed build keeps the last good one running and reports why. Switches,
// settings and stored values go through here too, so each change is announced.

import type { EventBus } from "../ports/EventBus.ts";
import type { PluginBuild, PluginBuilder, PluginDataStore, PluginFolder, PluginWorkspace } from "../ports/Plugins.ts";
import { NotFoundError, ValidationError } from "../errors/index.ts";
import { BUILTIN_PLUGIN_PREFIX } from "../../../contracts/src/builtin-plugins.ts";
import {
  PLUGINS_TOPIC, PLUGIN_MANIFEST_FILE, PLUGIN_UI_ENTRIES, PluginManifestSchema, pluginSettingValues, pluginStoreTopic,
  type PluginInfo, type PluginManifest, type PluginReport,
} from "../../../contracts/src/plugin.ts";

export interface PluginServiceDeps {
  readonly workspace: PluginWorkspace;
  readonly builder: PluginBuilder;
  readonly data: PluginDataStore;
  readonly bus: Pick<EventBus, "publish">;
  // Features that ship with Eos and switch on/off like plugins (no folder, no build).
  readonly builtins?: readonly PluginManifest[];
  readonly log?: { warn(msg: string, meta?: Record<string, unknown>): void };
  // Quiet window after a file change before rebuilding (an editor save often
  // writes several times).
  readonly debounceMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface Entry {
  // null for a built-in.
  folder: PluginFolder | null;
  manifest: PluginManifest | null;
  // Manifest or build problem; null when the plugin is healthy.
  error: string | null;
  // The last good build and its revision (0 = never built).
  build: PluginBuild | null;
  rev: number;
}

export class PluginService {
  private readonly deps: PluginServiceDeps;
  private readonly entries = new Map<string, Entry>();
  // One build at a time per plugin; a change during a build reruns it after.
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  // The latest word from a window about each plugin's build (loaded, or failed).
  private readonly reports = new Map<string, PluginReport>();
  private nextRev = 1;
  private stopWatching: (() => void) | null = null;

  constructor(deps: PluginServiceDeps) {
    this.deps = deps;
    for (const manifest of deps.builtins ?? []) {
      this.entries.set(manifest.id, { folder: null, manifest, error: null, build: null, rev: 0 });
    }
  }

  isEnabled(id: string): boolean {
    const e = this.entries.get(id);
    return Boolean(e) && this.enabledFor(id, e!.manifest);
  }

  // The built-ins switched off, for sessions starting now (their agent tools and
  // prompt sections are left out).
  disabledBuiltins(): string[] {
    return (this.deps.builtins ?? []).map((m) => m.id).filter((id) => !this.isEnabled(id));
  }

  // Scans every folder, builds the enabled ones, then follows changes on disk.
  async start(): Promise<void> {
    await Promise.all(this.deps.workspace.list().map((f) => this.refresh(f.id)));
    this.stopWatching = this.deps.workspace.watch((id) => this.schedule(id));
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    for (const t of this.timers.values()) (this.deps.clearTimer ?? clearTimeout)(t as ReturnType<typeof setTimeout>);
    this.timers.clear();
  }

  list(): PluginInfo[] {
    return [...this.entries.keys()].sort().map((id) => this.info(id));
  }

  get(id: string): PluginInfo {
    if (!this.entries.has(id)) throw new NotFoundError("plugin", id);
    return this.info(id);
  }

  // The build a window asks for by revision — only the current one is kept, so
  // a stale revision is gone (the window has a newer one coming).
  bundle(id: string, rev: number): PluginBuild | null {
    const e = this.entries.get(id);
    return e && e.rev === rev ? e.build : null;
  }

  // Re-reads one folder and rebuilds it when enabled; safe to call any time.
  refresh(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) {
      this.again.add(id);
      return running;
    }
    const run = this.reload(id).finally(() => {
      this.running.delete(id);
      if (this.again.delete(id)) void this.refresh(id);
    });
    this.running.set(id, run);
    return run;
  }

  async setEnabled(id: string, on: boolean): Promise<PluginInfo> {
    this.get(id);
    this.deps.data.setEnabled(id, on);
    await this.refresh(id);
    return this.info(id);
  }

  setSettings(id: string, values: Record<string, unknown>): PluginInfo {
    const e = this.entries.get(id);
    if (!e) throw new NotFoundError("plugin", id);
    const defs = e.manifest?.settings ?? {};
    for (const key of Object.keys(values)) {
      if (!defs[key]) throw new ValidationError(`plugin "${id}" has no setting "${key}"`);
    }
    const merged = { ...this.deps.data.settings(id), ...values };
    this.deps.data.setSettings(id, pluginSettingValues(e.manifest, merged));
    this.announce(id);
    return this.info(id);
  }

  // A window loaded a build, or it failed / crashed there.
  report(id: string, report: Omit<PluginReport, "at">, at: number): void {
    this.get(id);
    const prev = this.reports.get(id);
    // A late "loaded" for an old build doesn't hide a newer report.
    if (prev && prev.rev > report.rev) return;
    // A crash after the build loaded stays the news until a newer build loads.
    if (prev && prev.rev === report.rev && !prev.ok && report.ok) return;
    this.reports.set(id, { ...report, at });
  }

  lastReport(id: string): PluginReport | null {
    return this.reports.get(id) ?? null;
  }

  // A rebuild is waiting or running.
  isBusy(id: string): boolean {
    return this.timers.has(id) || this.running.has(id);
  }

  storeValue(id: string, key: string): unknown {
    this.get(id);
    return this.deps.data.storeValue(id, key);
  }

  setStoreValue(id: string, key: string, value: unknown): void {
    this.get(id);
    this.deps.data.setStoreValue(id, key, value);
    this.deps.bus.publish(pluginStoreTopic(id), { key });
  }

  private schedule(id: string): void {
    const set = this.deps.setTimer ?? setTimeout;
    const clear = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const prev = this.timers.get(id);
    if (prev !== undefined) clear(prev);
    this.timers.set(id, set(() => {
      this.timers.delete(id);
      void this.refresh(id);
    }, this.deps.debounceMs ?? 120));
  }

  private async reload(id: string): Promise<void> {
    if (this.isBuiltin(id)) {
      this.announce(id);
      return;
    }
    const folder = this.deps.workspace.read(id);
    if (!folder) {
      this.reports.delete(id);
      if (this.entries.delete(id)) this.announce(id);
      return;
    }
    const prev = this.entries.get(id);
    const entry: Entry = { folder, manifest: null, error: null, build: prev?.build ?? null, rev: prev?.rev ?? 0 };
    this.entries.set(id, entry);

    const parsed = id.startsWith(BUILTIN_PLUGIN_PREFIX)
      ? `the id "${id}" is reserved for Eos's built-in plugins — rename the folder (and the manifest id)`
      : parsePluginManifest(folder.manifestText, folder.id);
    if (typeof parsed === "string") {
      entry.error = parsed;
      this.announce(id);
      return;
    }
    entry.manifest = parsed;
    const entryFile = pluginUiEntry(parsed, folder.files);
    if (!this.enabledFor(id, parsed) || !entryFile) {
      if (!entryFile) {
        entry.build = null;
        entry.rev = 0;
      }
      this.announce(id);
      return;
    }
    try {
      entry.build = await this.deps.builder.build(folder.dir, entryFile);
      entry.rev = this.nextRev++;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      this.deps.log?.warn("plugin build failed", { plugin: id, error: entry.error });
    }
    // A newer change may have replaced this entry meanwhile; only the live one announces.
    if (this.entries.get(id) === entry) this.announce(id);
  }

  private isBuiltin(id: string): boolean {
    return (this.deps.builtins ?? []).some((m) => m.id === id);
  }

  private enabledFor(id: string, manifest: PluginManifest | null): boolean {
    const saved = this.deps.data.enabled()[id];
    return saved ?? !manifest?.experimental;
  }

  private info(id: string): PluginInfo {
    const e = this.entries.get(id)!;
    const enabled = this.enabledFor(id, e.manifest);
    return {
      id,
      builtin: e.folder === null,
      dir: e.folder?.dir ?? "",
      manifest: e.manifest,
      enabled,
      state: e.error ? "error" : enabled ? "active" : "disabled",
      error: e.error,
      rev: enabled ? e.rev : 0,
      hasUi: enabled && e.build !== null,
      hasCss: enabled && Boolean(e.build?.css),
      settings: pluginSettingValues(e.manifest, this.deps.data.settings(id)),
    };
  }

  private announce(id: string): void {
    this.deps.bus.publish(PLUGINS_TOPIC, { id });
  }
}

// The manifest, or why it can't be used. `folderId`: the folder it sits in,
// whose name the manifest id must match.
export function parsePluginManifest(text: string | null, folderId?: string): PluginManifest | string {
  if (text == null) return `${PLUGIN_MANIFEST_FILE} is missing`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `${PLUGIN_MANIFEST_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const r = PluginManifestSchema.safeParse(raw);
  if (!r.success) {
    return `${PLUGIN_MANIFEST_FILE}: ` + r.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; ");
  }
  if (folderId !== undefined && r.data.id !== folderId) return `${PLUGIN_MANIFEST_FILE}: id "${r.data.id}" must match the folder name "${folderId}"`;
  return r.data;
}

export function pluginUiEntry(manifest: PluginManifest, files: readonly string[]): string | null {
  if (manifest.ui) return manifest.ui;
  return PLUGIN_UI_ENTRIES.find((f) => files.includes(f)) ?? null;
}

