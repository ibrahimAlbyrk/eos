// PluginInstaller — adds a plugin someone else wrote, on the user's say-so. An
// install is staged first: fetched without running anything, its manifest
// checked and its UI test-built, then shown for review. Only an approved stage
// moves into the plugins folder (the plugin it replaces goes to the trash), and
// where it came from is recorded so it can be updated or removed later.

import type { PluginBuilder } from "../ports/Plugins.ts";
import type { PluginFetcher, PluginInstallStore, PluginStaging } from "../ports/PluginInstall.ts";
import { NotFoundError, ValidationError } from "../errors/index.ts";
import { parsePluginManifest, pluginUiEntry } from "./PluginService.ts";
import { BUILTIN_PLUGIN_PREFIX } from "../../../contracts/src/builtin-plugins.ts";
import type { PluginInfo, PluginManifest } from "../../../contracts/src/plugin.ts";
import type { PluginInstallRecord, PluginSource, StagedPlugin } from "../../../contracts/src/plugin-install.ts";

export interface PluginInstallerDeps {
  readonly fetcher: PluginFetcher;
  readonly staging: PluginStaging;
  readonly records: PluginInstallStore;
  readonly builder: PluginBuilder;
  // The plugin list, re-read once a folder changes.
  readonly plugins: { refresh(id: string): Promise<void>; get(id: string): PluginInfo };
  readonly now: () => number;
}

// Stages waiting for review; past this many the oldest is dropped.
const MAX_PENDING = 4;

export class PluginInstaller {
  private readonly deps: PluginInstallerDeps;
  private readonly pending = new Map<string, StagedPlugin>();

  constructor(deps: PluginInstallerDeps) {
    this.deps = deps;
  }

  // Stages left over from before a restart are dropped.
  start(): void {
    this.deps.staging.clear();
  }

  // Where each installed plugin came from.
  installs(): Record<string, PluginInstallRecord> {
    return this.deps.records.all();
  }

  async stage(source: PluginSource): Promise<StagedPlugin> {
    const { id: stagingId, dir } = this.deps.staging.create();
    try {
      const fetched = await this.deps.fetcher.fetch(source, dir);
      const folder = this.deps.staging.inspect(stagingId);
      const manifest = parsePluginManifest(folder.manifestText);
      if (typeof manifest === "string") throw new ValidationError(`not an Eos plugin — ${manifest}`);
      if (manifest.id.startsWith(BUILTIN_PLUGIN_PREFIX)) throw new ValidationError(`the id "${manifest.id}" is reserved for Eos's built-in plugins`);
      await this.testBuild(dir, manifest, folder.topFiles);
      const record = this.deps.records.get(manifest.id);
      const staged: StagedPlugin = {
        stagingId,
        manifest,
        source,
        resolved: fetched.resolved,
        integrity: fetched.integrity,
        files: folder.files,
        bytes: folder.bytes,
        replaces: this.deps.staging.has(manifest.id) ? { version: record?.version ?? null, installed: record !== null } : null,
      };
      this.remember(staged);
      return staged;
    } catch (e) {
      this.deps.staging.discard(stagingId);
      throw e;
    }
  }

  // Stages the newest version from where the plugin was installed from: the
  // same tag (an exact version follows "latest"), branch or folder.
  async stageUpdate(id: string): Promise<StagedPlugin> {
    const record = this.deps.records.get(id);
    if (!record) throw new ValidationError(`"${id}" wasn't installed from npm, git or a folder — there's nothing to update it from`);
    const source = record.source.kind === "npm" && record.source.version && /^\d/.test(record.source.version)
      ? { kind: "npm" as const, name: record.source.name }
      : record.source;
    return this.stage(source);
  }

  async commit(stagingId: string): Promise<PluginInfo> {
    const staged = this.pending.get(stagingId);
    if (!staged) throw new NotFoundError("staged plugin", stagingId);
    const id = staged.manifest.id;
    this.deps.staging.promote(stagingId, id);
    this.pending.delete(stagingId);
    this.deps.records.set(id, {
      source: staged.source,
      resolved: staged.resolved,
      integrity: staged.integrity,
      version: staged.manifest.version ?? null,
      installedAt: this.deps.now(),
    });
    await this.deps.plugins.refresh(id);
    return this.deps.plugins.get(id);
  }

  discard(stagingId: string): void {
    this.pending.delete(stagingId);
    this.deps.staging.discard(stagingId);
  }

  // Any plugin with a folder — installed or written here — goes to the trash.
  async remove(id: string): Promise<void> {
    if (!this.deps.staging.has(id)) throw new NotFoundError("plugin", id);
    this.deps.staging.trash(id);
    this.deps.records.remove(id);
    await this.deps.plugins.refresh(id);
  }

  private async testBuild(dir: string, manifest: PluginManifest, topFiles: readonly string[]): Promise<void> {
    const entry = pluginUiEntry(manifest, topFiles);
    if (!entry) return;
    try {
      await this.deps.builder.build(dir, entry);
    } catch (e) {
      throw new ValidationError(`the plugin doesn't build: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private remember(staged: StagedPlugin): void {
    this.pending.set(staged.stagingId, staged);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value!;
      this.discard(oldest);
    }
  }
}
