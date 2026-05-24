import { homedir } from "node:os";

export function expandPath(p: string | undefined): string | undefined {
  if (!p) return p;
  let out = p.trim();
  if (out.startsWith("~")) {
    const home = process.env.HOME || homedir();
    out = out === "~" || out.startsWith("~/") ? home + out.slice(1) : out;
  }
  return out;
}
