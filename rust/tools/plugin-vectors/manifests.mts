// Records what today's manifest check (core/src/services/PluginService.ts:
// parsePluginManifest, pluginUiEntry) answers for a set of plugin.json texts,
// for the Rust port to equal:
//
//   node --no-warnings --experimental-strip-types rust/tools/plugin-vectors/manifests.mts
//
// Needs `npm ci` in contracts/. Writes
// rust/crates/eos-mod-plugins/tests/vectors/manifests.json.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginManifest, pluginUiEntry } from "../../../core/src/services/PluginService.ts";

const j = (v: unknown) => JSON.stringify(v);
const setting = { type: "boolean", title: "Seconds", default: false };

// [name, plugin.json text (null = no file), folder id (null = none given), top-level files]
const cases: Array<[string, string | null, string | null, string[]]> = [
  ["minimal", j({ id: "clock", name: "Clock" }), "clock", ["plugin.json", "ui.jsx"]],
  ["full", j({
    id: "acme.sticky-notes", name: "Notes", description: "d", version: "1.2.0", icon: "<svg/>", ui: "src/main.tsx", experimental: true,
    settings: {
      seconds: setting,
      label: { type: "string", title: "Label", default: "x", placeholder: "p", multiline: true, description: "why" },
      size: { type: "number", title: "Size", default: 12.5, min: 1, max: 40, step: 0.5 },
      zone: { type: "select", title: "Zone", options: [{ value: "utc", label: "UTC" }], default: "utc" },
    },
  }), "acme.sticky-notes", ["plugin.json", "src"]],
  ["unknown keys are dropped", j({ id: "clock", name: "Clock", author: "me", settings: { a: { ...setting, extra: 1 } } }), "clock", ["plugin.json"]],
  ["no file", null, "clock", []],
  ["no folder id given", j({ id: "clock", name: "Clock" }), null, ["ui.ts", "ui.js"]],
  ["entry order", j({ id: "clock", name: "Clock" }), "clock", ["ui.js", "ui.ts", "ui.jsx", "ui.tsx"]],
  ["no entry", j({ id: "clock", name: "Clock" }), "clock", ["plugin.json", "main.jsx"]],
  ["id differs from folder", j({ id: "other", name: "Other" }), "clock", []],
  ["missing id", j({ name: "no id" }), "clock", []],
  ["missing name", j({ id: "clock" }), "clock", []],
  ["empty name", j({ id: "clock", name: "" }), "clock", []],
  ["long name", j({ id: "clock", name: "n".repeat(61) }), "clock", []],
  ["bad id", j({ id: "Bad_Id", name: "x" }), "Bad_Id", []],
  ["long id", j({ id: "a".repeat(65), name: "x" }), null, []],
  ["id not a string", j({ id: 5, name: "x" }), null, []],
  ["name not a string", j({ id: "clock", name: 5 }), null, []],
  ["not an object", j(["clock"]), null, []],
  ["null", "null", null, []],
  ["a string", j("clock"), null, []],
  ["long description", j({ id: "clock", name: "x", description: "d".repeat(301) }), null, []],
  ["long version", j({ id: "clock", name: "x", version: "v".repeat(41) }), null, []],
  ["long icon", j({ id: "clock", name: "x", icon: "i".repeat(8001) }), null, []],
  ["experimental not a flag", j({ id: "clock", name: "x", experimental: "yes" }), null, []],
  ["settings not an object", j({ id: "clock", name: "x", settings: [] }), null, []],
  ["bad setting key", j({ id: "clock", name: "x", settings: { "1st": setting } }), null, []],
  ["setting without title", j({ id: "clock", name: "x", settings: { a: { type: "boolean" } } }), null, []],
  ["setting with empty title", j({ id: "clock", name: "x", settings: { a: { type: "string", title: "" } } }), null, []],
  ["unknown setting type", j({ id: "clock", name: "x", settings: { a: { type: "color", title: "A" } } }), null, []],
  ["setting without type", j({ id: "clock", name: "x", settings: { a: { title: "A" } } }), null, []],
  ["select without options", j({ id: "clock", name: "x", settings: { a: { type: "select", title: "A", options: [] } } }), null, []],
  ["wrong default type", j({ id: "clock", name: "x", settings: { a: { type: "number", title: "A", default: "3" } } }), null, []],
  ["two problems", j({ id: "Bad Id", name: "" }), null, []],
  ["two constraint problems in settings", j({ id: "clock", name: "x", settings: { a: { type: "string", title: "" }, "b!": setting } }), null, []],
];

const out = cases.map(([name, text, folderId, files]) => {
  const parsed = parsePluginManifest(text, folderId ?? undefined);
  return typeof parsed === "string"
    ? { name, text, folderId, files, error: parsed }
    : { name, text, folderId, files, manifest: parsed, entry: pluginUiEntry(parsed, files) };
});

const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../crates/eos-mod-plugins/tests/vectors/manifests.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`${out.length} manifests`);
