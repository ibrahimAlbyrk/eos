// What `npm start` needs before Electron runs: the UI build and this system's
// native helpers — each built only when missing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const has = (p) => existsSync(path.join(appDir, p));
const run = (file, args) => execFileSync(file, args, { cwd: appDir, stdio: "inherit", shell: process.platform === "win32" });

if (!has("ui/dist/index.html")) run("npm", ["run", "build:ui"]);

const HELPERS = {
  darwin: [["Eos.saver", "build-saver.mjs"], ["EosLocation.app", "build-location.mjs"]],
  win32: [["EosHelper.exe", "build-helper.mjs"]],
};
for (const [built, script] of HELPERS[process.platform] ?? []) {
  if (!has(path.join(".forge-build", built))) run("node", [path.join("scripts", script)]);
}
