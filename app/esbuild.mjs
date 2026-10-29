// Bundles the main and preload processes into single CJS files under
// .forge-build/ (doc 30 Claim 3.6: one bundled main, require() cost paid once).
// Sandboxed preloads must be CommonJS, so every target is format:"cjs".
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main/index.ts"], outfile: ".forge-build/main.js" });
await build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: ".forge-build/preload.js" });
// The claude.ai artifact views' own preload (their floating toolbar).
await build({ ...common, entryPoints: ["src/preload/artifactOverlay.ts"], outfile: ".forge-build/artifactOverlay.js" });
// The in-app update applier: copied out of app.asar and run as plain Node (main/updates.ts).
await build({ ...common, entryPoints: ["src/updater/apply.ts"], outfile: ".forge-build/apply.js", sourcemap: false });

console.log("bundled main + preloads + updater -> .forge-build/");
