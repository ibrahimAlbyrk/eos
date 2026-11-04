// Builds a plugin's UI entry into one ES module (+ one stylesheet when it
// imports CSS). React and react-dom are not bundled: imports of them resolve to
// the dashboard's own copy, which it exposes as globalThis.__eosShared — a
// second React would break hooks. Nothing else outside the folder resolves, so a
// plugin is self-contained by construction.

import { build, type Message, type Plugin } from "esbuild";
import { join, relative } from "node:path";
import type { PluginBuild, PluginBuilder } from "../../../core/src/ports/Plugins.ts";

export const SHARED_MODULES = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"];

const shared: Plugin = {
  name: "eos-shared",
  setup(b) {
    const filter = new RegExp(`^(${SHARED_MODULES.map((m) => m.replace("/", "\\/")).join("|")})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "eos-shared" }));
    b.onLoad({ filter: /.*/, namespace: "eos-shared" }, (args) => ({
      contents: `module.exports = globalThis.__eosShared[${JSON.stringify(args.path)}];`,
      loader: "js",
    }));
  },
};

export class EsbuildPluginBuilder implements PluginBuilder {
  async build(dir: string, entry: string): Promise<PluginBuild> {
    let result;
    try {
      result = await build({
        entryPoints: { ui: join(dir, entry) },
        absWorkingDir: dir,
        bundle: true,
        write: false,
        outdir: "out",
        format: "esm",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        loader: { ".svg": "text", ".png": "dataurl", ".jpg": "dataurl", ".gif": "dataurl", ".webp": "dataurl" },
        logLevel: "silent",
        plugins: [shared],
      });
    } catch (e) {
      const errors = (e as { errors?: Message[] }).errors;
      throw new Error(errors?.length ? errors.map((m) => describe(m, dir)).join("\n") : e instanceof Error ? e.message : String(e));
    }
    const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
    const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? null;
    return { js, css };
  }
}

function describe(m: Message, dir: string): string {
  const where = m.location ? `${relative(dir, join(dir, m.location.file)) || m.location.file}:${m.location.line}:${m.location.column + 1}: ` : "";
  const hint = /^Could not resolve "[^./]/.test(m.text)
    ? ` — a plugin can import only its own files and ${SHARED_MODULES.join(", ")}`
    : "";
  return `${where}${m.text}${hint}`;
}
