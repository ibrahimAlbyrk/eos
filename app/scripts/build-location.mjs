// Builds the location helper → .forge-build/EosLocation.app (shipped under
// Contents/Resources by forge's extraResource; main/location.ts runs its
// executable directly). A bundle, not a bare binary: macOS shows the location
// prompt only for a bundle's executable (location/Info.plist).
// arm64-only, like the app. Ad-hoc signed here: Apple Silicon refuses unsigned
// code; a Developer ID build re-signs it with the app (osxSign).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(appDir, ".forge-build", "EosLocation.app");
const contents = path.join(out, "Contents");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(contents, "MacOS"), { recursive: true });

execFileSync("xcrun", [
  "swiftc", "-O",
  "-target", "arm64-apple-macos14.0",
  "-o", path.join(contents, "MacOS", "eos-location"),
  path.join(appDir, "location", "main.swift"),
], { stdio: "inherit" });
copyFileSync(path.join(appDir, "location", "Info.plist"), path.join(contents, "Info.plist"));
execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });

console.log("built location helper ->", path.relative(appDir, out));
