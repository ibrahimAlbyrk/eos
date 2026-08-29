import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface Health {
  ok: boolean;
  pid?: number;
  sourceStamp?: string;
}

const HEX_RE = /^[0-9a-f]+$/;

// The only secret: a per-boot token the daemon writes as plaintext to
// ~/.eos/ui-token (doc 10 §e — no Keychain, the daemon owns this file's
// lifecycle). Validate lowercase hex like the Swift shell does.
export async function readUiToken(): Promise<string> {
  const file = path.join(homedir(), ".eos", "ui-token");
  const raw = (await readFile(file, "utf8")).trim();
  if (!HEX_RE.test(raw)) {
    throw new Error(`~/.eos/ui-token is not lowercase hex (${raw.length} chars)`);
  }
  return raw;
}

export async function probeHealth(daemonUrl: string, timeoutMs = 1500): Promise<Health | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonUrl}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body?.ok ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Poll /health up to `tries` x `intervalMs` (doc 10 §e: 40 x 0.25s). Since this
// dev scaffold reuses the already-running daemon, the first probe normally wins.
export async function waitForHealthy(daemonUrl: string, tries = 40, intervalMs = 250): Promise<Health> {
  for (let i = 0; i < tries; i++) {
    const h = await probeHealth(daemonUrl);
    if (h) return h;
    await delay(intervalMs);
  }
  throw new Error(`daemon at ${daemonUrl} did not become healthy after ${tries} tries`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
