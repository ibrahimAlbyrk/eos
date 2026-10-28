// Builds EosHelper.exe (helper-win/, C# native AOT) → .forge-build/EosHelper.exe
// for this machine's arch (shipped under resources/ by forge's extraResource;
// main/platform/win32.ts and the daemon run it). Needs the .NET 8 SDK; native
// AOT builds only for the arch it runs on, so each arch builds on its own runner.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishDir = path.join(appDir, "helper-win", "bin", "publish");
const out = path.join(appDir, ".forge-build", "EosHelper.exe");

execFileSync("dotnet", [
  "publish", path.join(appDir, "helper-win", "EosHelper.csproj"),
  "-c", "Release",
  "-r", `win-${process.arch}`,
  "-o", publishDir,
], { stdio: "inherit" });
mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(path.join(publishDir, "EosHelper.exe"), out);

console.log("built EosHelper ->", path.relative(appDir, out));
