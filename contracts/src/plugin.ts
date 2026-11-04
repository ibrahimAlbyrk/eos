// Plugins: a folder under ~/.eos/plugins/<id>/ holding a plugin.json manifest
// and, optionally, a UI entry (ui.jsx / ui.tsx / ui.js) whose default export
// activates it in the dashboard. Eos builds the entry itself and reloads it the
// moment a file changes — no restart. Settings declared in the manifest get a
// generated page under Settings › Plugins.

import { z } from "zod";

export const PLUGIN_MANIFEST_FILE = "plugin.json";
// The UI entry Eos looks for when the manifest names none, in this order.
export const PLUGIN_UI_ENTRIES = ["ui.tsx", "ui.jsx", "ui.ts", "ui.js"] as const;

// Lowercase words joined by "-" or ".", e.g. "clock", "acme.sticky-notes".
export const PluginIdSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "lowercase letters, digits, \"-\" and \".\"").max(64);

const SettingBase = {
  title: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
};

export const PluginSettingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), default: z.boolean().optional(), ...SettingBase }),
  z.object({ type: z.literal("string"), default: z.string().optional(), placeholder: z.string().optional(), multiline: z.boolean().optional(), ...SettingBase }),
  z.object({ type: z.literal("number"), default: z.number().optional(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), ...SettingBase }),
  z.object({
    type: z.literal("select"),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
    default: z.string().optional(),
    ...SettingBase,
  }),
]);
export type PluginSetting = z.infer<typeof PluginSettingSchema>;

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  version: z.string().max(40).optional(),
  // An inline SVG (24×24 viewBox, currentColor) shown in Settings › Plugins.
  icon: z.string().max(8000).optional(),
  // UI entry, relative to the plugin folder. Defaults to the first of PLUGIN_UI_ENTRIES that exists.
  ui: z.string().optional(),
  settings: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/), PluginSettingSchema).optional(),
  experimental: z.boolean().optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// active   — enabled; its UI (if any) is built and loads in every window
// disabled — turned off in Settings
// error    — the manifest or the build failed; `error` says why (the last good
//            build, if any, keeps running)
export const PluginStateSchema = z.enum(["active", "disabled", "error"]);
export type PluginState = z.infer<typeof PluginStateSchema>;

export const PluginSettingValueSchema = z.union([z.boolean(), z.string(), z.number()]);
export type PluginSettingValue = z.infer<typeof PluginSettingValueSchema>;

export const PluginInfoSchema = z.object({
  id: z.string(),
  // Ships with Eos (contracts/src/builtin-plugins.ts): no folder, no build — its
  // UI is part of the app and follows `enabled`.
  builtin: z.boolean(),
  dir: z.string(),
  // null when plugin.json is missing or invalid (state "error").
  manifest: PluginManifestSchema.nullable(),
  enabled: z.boolean(),
  state: PluginStateSchema,
  error: z.string().nullable(),
  // Bumps on every successful build; the UI loads /ui/plugins/<id>/<rev>.js.
  rev: z.number().int(),
  hasUi: z.boolean(),
  hasCss: z.boolean(),
  // Current values, defaults filled in.
  settings: z.record(PluginSettingValueSchema),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

// What a window reports after loading a build (ok) or when it failed to load or
// a component crashed (ok: false, with the error).
export const PluginReportRequestSchema = z.object({
  rev: z.number().int(),
  ok: z.boolean(),
  error: z.string().max(8000).optional(),
});
export type PluginReport = z.infer<typeof PluginReportRequestSchema> & { at: number };

export const PluginEnabledRequestSchema = z.object({ enabled: z.boolean() });
export const PluginSettingsRequestSchema = z.object({ values: z.record(PluginSettingValueSchema) });
export const PluginStoreRequestSchema = z.object({ value: z.unknown() });
export const PluginStoreKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);

// Bus topics. plugins:change {id} — a plugin was added, removed, rebuilt,
// toggled or re-set; plugin:<id>:store {key} — one stored value changed.
export const PLUGINS_TOPIC = "plugins:change";
export const pluginStoreTopic = (id: string) => `plugin:${id}:store` as const;

// Defaults filled in, unknown keys and mistyped values dropped.
export function pluginSettingValues(
  manifest: PluginManifest | null,
  saved: Record<string, unknown>,
): Record<string, PluginSettingValue> {
  const out: Record<string, PluginSettingValue> = {};
  for (const [key, def] of Object.entries(manifest?.settings ?? {})) {
    const v = saved[key];
    const ok = def.type === "select"
      ? typeof v === "string" && def.options.some((o) => o.value === v)
      : typeof v === def.type;
    if (ok) out[key] = v as PluginSettingValue;
    else if (def.default !== undefined) out[key] = def.default;
  }
  return out;
}
