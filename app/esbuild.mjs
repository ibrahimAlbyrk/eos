// Bundles the main and preload processes into single CJS files under
// .forge-build/ (doc 30 Claim 3.6: one bundled main, require() cost paid once).
// Sandboxed preloads must be CommonJS, so both targets are format:"cjs".
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron", "electron-updater"],
  sourcemap: true,
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main/index.ts"], outfile: ".forge-build/main.js" });
await build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: ".forge-build/preload.js" });

console.log("bundled main + preload -> .forge-build/");
