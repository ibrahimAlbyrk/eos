// Sync domain over a folder of hand-editable markdown files read fresh on every use
// (~/.eos/templates, ~/.eos/workers): one record per <id>.md, plus — for templates —
// the files in assets/<id>/. There is no change event; the periodic pass notices
// edits. Deletes are soft (.trash/), like the services that own these folders.
//
// Ids and asset names come from another Mac, so both are checked before they touch
// a path.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { SyncDomain, SyncItem } from "../../../core/src/ports/SyncDomain.ts";
import type { SyncDomainName } from "../../../contracts/src/sync.ts";
import { moveToTrash, writeFileAtomic } from "../../../infra/src/persistence/atomic-file.ts";

const ASSET_NAME_RE = /^[^/\\\0.][^/\\\0]{0,200}$/;

const FileRecordSchema = z.object({
  md: z.string(),
  assets: z.record(z.string().regex(ASSET_NAME_RE), z.string()).optional(),
});

export interface FileDirDomainOptions {
  readonly name: SyncDomainName;
  readonly dir: string;
  readonly idPattern: RegExp;
  // Carry <dir>/assets/<id>/* with the record (templates).
  readonly withAssets?: boolean;
}

export function fileDirDomain(opts: FileDirDomainOptions): SyncDomain {
  const mdPath = (id: string): string => join(opts.dir, `${id}.md`);
  const assetDir = (id: string): string => join(opts.dir, "assets", id);
  const checkId = (id: string): void => {
    if (!opts.idPattern.test(id)) throw new Error(`invalid ${opts.name} id ${id}`);
  };

  const readAssets = (id: string): Record<string, string> | undefined => {
    if (!opts.withAssets || !existsSync(assetDir(id))) return undefined;
    const out: Record<string, string> = {};
    for (const f of readdirSync(assetDir(id)).sort()) {
      const p = join(assetDir(id), f);
      if (ASSET_NAME_RE.test(f) && statSync(p).isFile()) out[f] = readFileSync(p).toString("base64");
    }
    return Object.keys(out).length ? out : undefined;
  };

  const read = (id: string): SyncItem | null => {
    if (!opts.idPattern.test(id) || !existsSync(mdPath(id))) return null;
    const md = readFileSync(mdPath(id), "utf8");
    const assets = readAssets(id);
    return { id, data: assets ? { md, assets } : { md }, updatedAt: statSync(mdPath(id)).mtimeMs };
  };

  return {
    name: opts.name,
    list: async () => {
      if (!existsSync(opts.dir)) return [];
      return readdirSync(opts.dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => read(f.slice(0, -".md".length)))
        .filter((x): x is SyncItem => x !== null);
    },
    get: async (id) => read(id),
    apply: async (id, data) => {
      checkId(id);
      const rec = FileRecordSchema.parse(data);
      if (opts.withAssets) {
        const dir = assetDir(id);
        const keep = new Set(Object.keys(rec.assets ?? {}));
        if (existsSync(dir)) for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { recursive: true, force: true });
        for (const [f, b64] of Object.entries(rec.assets ?? {})) writeFileAtomic(join(dir, f), Buffer.from(b64, "base64"));
      }
      writeFileAtomic(mdPath(id), rec.md);
    },
    remove: async (id) => {
      checkId(id);
      moveToTrash(opts.dir, id, "md");
      if (opts.withAssets && existsSync(assetDir(id))) {
        const trash = join(opts.dir, ".trash", "assets");
        mkdirSync(trash, { recursive: true });
        renameSync(assetDir(id), join(trash, `${id}.${Date.now()}`));
      }
    },
  };
}
