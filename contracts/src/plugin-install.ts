// Installing a plugin someone else wrote (Settings › Plugins › Add plugin): from
// npm, a git repository or a folder on this Mac. Only the user does this, from
// the dashboard — no agent tool reaches these routes. An install is staged
// first (fetched, checked, test-built) and shown for review; only an approved
// one replaces anything in ~/.eos/plugins.

import { z } from "zod";
import { PluginManifestSchema } from "./plugin.ts";

// npm:   a package name, optionally @ an exact version or a dist-tag ("latest").
// git:   an https URL, optionally a branch or tag.
// local: a folder on this Mac (copied in; edits to the original don't follow).
export const PluginSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("npm"),
    name: z.string().regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, "an npm package name").max(214),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/, "an exact version or a tag").max(64).optional(),
  }),
  z.object({
    kind: z.literal("git"),
    url: z.string().regex(/^https:\/\/[^\s]+$/, "an https:// repository URL").max(500),
    ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "a branch or tag name").max(200).optional(),
  }),
  z.object({ kind: z.literal("local"), path: z.string().min(1).max(1000) }),
]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

// Where an installed plugin came from, exactly — kept in ~/.eos/plugin-data/installed.json.
export const PluginInstallRecordSchema = z.object({
  source: PluginSourceSchema,
  // The tarball URL (npm), the commit (git) or the folder (local).
  resolved: z.string(),
  // npm's own integrity hash (sha512-…), "git:<commit>" or null for a folder.
  integrity: z.string().nullable(),
  version: z.string().nullable(),
  installedAt: z.number(),
});
export type PluginInstallRecord = z.infer<typeof PluginInstallRecordSchema>;

// A fetched, checked plugin waiting for the user's go-ahead.
export const StagedPluginSchema = z.object({
  stagingId: z.string(),
  manifest: PluginManifestSchema,
  source: PluginSourceSchema,
  resolved: z.string(),
  integrity: z.string().nullable(),
  files: z.number().int(),
  bytes: z.number().int(),
  // The plugin it would replace: an installed one (with its version), or one
  // written on this Mac (an agent's or the user's own folder).
  replaces: z.object({ version: z.string().nullable(), installed: z.boolean() }).nullable(),
});
export type StagedPlugin = z.infer<typeof StagedPluginSchema>;

export const PluginInstallStageRequestSchema = z.object({ source: PluginSourceSchema });
export const PluginStagingIdSchema = z.string().regex(/^st-[a-z0-9]{8,32}$/);
