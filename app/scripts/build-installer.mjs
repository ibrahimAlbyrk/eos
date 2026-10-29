// Builds Eos Setup (installer-win/, Rust + WebView2) for this machine's arch and
// appends the packaged app — Forge's zip — behind it, with the footer the
// installer finds it by (installer-win/src/payload.rs): out/make/Eos-Setup-<arch>.exe.
//
//   node scripts/build-installer.mjs <path to Eos-win32-<arch>-<version>.zip>
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zip = process.argv[2];
if (!zip) throw new Error("usage: build-installer.mjs <app zip>");

const arch = process.arch === "arm64" ? "arm64" : "x64";
const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
const { version } = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
const crate = path.join(appDir, "installer-win");

execFileSync("cargo", ["build", "--release", "--locked", "--target", triple], {
  cwd: crate,
  stdio: "inherit",
  env: { ...process.env, EOS_VERSION: version },
});

const stub = readFileSync(path.join(crate, "target", triple, "release", "eos-setup.exe"));
const out = path.join(appDir, "out", "make", `Eos-Setup-${arch}.exe`);
const payloadLen = statSync(zip).size;

const fd = openSync(out, "w");
writeSync(fd, stub);
// Stream the zip in, then the footer: magic, payload offset, payload length.
const src = openSync(zip, "r");
const chunk = Buffer.alloc(8 * 1024 * 1024);
for (let pos = 0, n; (n = readSync(src, chunk, 0, chunk.length, pos)) > 0; pos += n) writeSync(fd, chunk, 0, n);
closeSync(src);
const footer = Buffer.alloc(24);
footer.write("EOSPAYLD", 0, "ascii");
footer.writeBigUInt64LE(BigInt(stub.length), 8);
footer.writeBigUInt64LE(BigInt(payloadLen), 16);
writeSync(fd, footer);
closeSync(fd);

console.log(`built ${path.relative(appDir, out)} (${(statSync(out).size / 1048576).toFixed(0)} MB)`);
