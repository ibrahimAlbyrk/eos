// An env whose PATH also reaches `dir`, appended so a CLI the user installed
// still wins. Windows spells the variable "Path"; whichever key is there is kept.

import { delimiter } from "node:path";

export function appendToPath(env: Record<string, string | undefined>, dir: string): Record<string, string | undefined> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key];
  if (current?.split(delimiter).includes(dir)) return env;
  return { ...env, [key]: current ? `${current}${delimiter}${dir}` : dir };
}
