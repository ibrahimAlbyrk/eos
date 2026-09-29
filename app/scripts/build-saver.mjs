// Builds the Eos screen saver bundle → .forge-build/Eos.saver (shipped under
// Contents/Resources by forge's extraResource; installed by the tray menu).
// arm64-only, like the app. Ad-hoc signed: Apple Silicon refuses unsigned code.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(appDir, "saver");
const out = path.join(appDir, ".forge-build", "Eos.saver");
const contents = path.join(out, "Contents");
const resources = path.join(contents, "Resources");
const fonts = path.join(appDir, "ui", "node_modules");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(contents, "MacOS"), { recursive: true });
mkdirSync(resources, { recursive: true });

execFileSync("xcrun", [
  "swiftc", "-O",
  "-target", "arm64-apple-macos14.0",
  "-module-name", "EosSaver",
  "-emit-library", "-Xlinker", "-bundle",
  "-o", path.join(contents, "MacOS", "EosSaver"),
  ...readdirSync(src).filter((f) => f.endsWith(".swift")).map((f) => path.join(src, f)),
], { stdio: "inherit" });
copyFileSync(path.join(src, "Info.plist"), path.join(contents, "Info.plist"));
// The scene's shader ships as source: the saver compiles it at runtime, so building needs no Metal toolchain.
copyFileSync(path.join(src, "FirstLight.metal"), path.join(resources, "FirstLight.metal"));
// The tile System Settings shows in the saver picker (Apple's legacy-saver convention: 90×58 pt + @2x).
for (const f of ["thumbnail.png", "thumbnail@2x.png"]) copyFileSync(path.join(src, f), path.join(resources, f));
// The clock's faces, taken from the UI's own font packages.
copyFileSync(path.join(fonts, "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"), path.join(resources, "Geist.woff2"));
copyFileSync(path.join(fonts, "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2"), path.join(resources, "IBMPlexMono.woff2"));
execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });

console.log("built screen saver ->", path.relative(appDir, out));
