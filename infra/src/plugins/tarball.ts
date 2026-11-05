// Unpacks an npm package tarball (.tgz) into a folder: plain files and folders
// only. A link, a path that leaves the folder or a package past the size limits
// fails the whole unpack — nothing in it is ever run. npm puts everything under
// "package/"; that first segment is dropped.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export const PACKAGE_LIMITS = { files: 2000, bytes: 20 * 1024 * 1024 } as const;

const BLOCK = 512;

export function extractTarGz(tgz: Uint8Array, dir: string): void {
  const tar = gunzipSync(tgz, { maxOutputLength: PACKAGE_LIMITS.bytes * 2 });
  let off = 0;
  let files = 0;
  let bytes = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") { longName = cstr(body); continue; }
    if (type === "x") { paxPath = paxField(body, "path"); continue; }
    if (type === "g") continue;

    const prefix = cstr(header.subarray(345, 500));
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${cstr(header.subarray(0, 100))}` : cstr(header.subarray(0, 100)));
    longName = null;
    paxPath = null;

    const rel = name.split("/").slice(1).join("/");
    if (type !== "0" && type !== "5") throw new Error(`the package holds a link or special file (${name}) — not allowed in a plugin`);
    if (!rel) continue;
    const target = safeJoin(dir, rel);
    if (type === "5") { mkdirSync(target, { recursive: true }); continue; }
    files++;
    bytes += size;
    if (files > PACKAGE_LIMITS.files || bytes > PACKAGE_LIMITS.bytes) {
      throw new Error(`the package is too big for a plugin (over ${PACKAGE_LIMITS.files} files or ${PACKAGE_LIMITS.bytes / 1024 / 1024} MB)`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

// `rel` inside `dir`, or an error.
export function safeJoin(dir: string, rel: string): string {
  const clean = normalize(rel);
  if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`)) throw new Error(`the package has a path outside its folder: ${rel}`);
  return join(dir, clean);
}

function cstr(b: Uint8Array): string {
  const end = b.indexOf(0);
  return Buffer.from(end === -1 ? b : b.subarray(0, end)).toString("utf8");
}

function octal(b: Uint8Array): number {
  const n = parseInt(cstr(b).trim() || "0", 8);
  if (!Number.isFinite(n) || n < 0) throw new Error("the package isn't a valid tarball");
  return n;
}

// One field of a pax extended header ("<len> <key>=<value>\n" records).
function paxField(body: Uint8Array, key: string): string | null {
  for (const line of Buffer.from(body).toString("utf8").split("\n")) {
    const m = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (m && m[1] === key) return m[2];
  }
  return null;
}
