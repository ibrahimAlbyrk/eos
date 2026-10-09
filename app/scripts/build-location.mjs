// Builds the location helper → .forge-build/eos-location (shipped under
// Contents/Resources by forge's extraResource; run by main/location.ts).
// arm64-only, like the app. Ad-hoc signed here: Apple Silicon refuses unsigned
// code; a Developer ID build re-signs it with the app (osxSign).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(appDir, ".forge-build", "eos-location");

rmSync(out, { force: true });
mkdirSync(path.dirname(out), { recursive: true });

execFileSync("xcrun", [
  "swiftc", "-O",
  "-target", "arm64-apple-macos14.0",
  // The prompt's name and usage string come from this embedded plist (location/Info.plist).
  "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
  "-Xlinker", path.join(appDir, "location", "Info.plist"),
  "-o", out,
  path.join(appDir, "location", "main.swift"),
], { stdio: "inherit" });
execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });

console.log("built location helper ->", path.relative(appDir, out));
