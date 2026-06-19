// Node exposes no setrlimit binding, so the daemon cannot raise its own fd soft
// limit in-process. Instead it self-elevates ONCE at boot: re-exec under a bash
// `ulimit` wrapper via process.execve, which replaces the process image in the
// SAME pid (bash's `exec` then keeps that pid → the pidfile and the macOS app's
// child-pid tracking stay valid). The EOS_FD_RAISED guard breaks any re-exec
// loop (a hard limit below the target would otherwise re-trigger forever).
//
// Why own this here instead of only in the launchers: the high fd ceiling is a
// runtime invariant the daemon DEPENDS ON (it supervises many PTYs + file
// watches). Owning it at the one place that needs it covers every launch path
// from a single source — `eos start`, `eos start -f`, the macOS app, and a bare
// `node manager/daemon.ts` — replacing a bash `ulimit` string that was
// duplicated across launchers and missing from the foreground path. Those
// launcher ulimits remain as harmless defense-in-depth.

import { softFdLimit } from "../../infra/src/util/fd-stats.ts";

const DEFAULT_FD_SOFT_TARGET = 10240;

type Execve = (file: string, args: string[], env: Record<string, string>) => never;

export function ensureFdLimit(target = DEFAULT_FD_SOFT_TARGET): void {
  if (process.env.EOS_FD_RAISED) return; // already attempted this boot — never loop
  if (process.platform === "win32") return; // no ulimit / execve

  // process.execve is POSIX-only and experimental (Node 23+); accessed
  // defensively so a missing @types/node binding doesn't fail the type-check.
  const execve = (process as { execve?: Execve }).execve;
  if (typeof execve !== "function") return; // older Node — rely on launcher ulimit

  const current = softFdLimit();
  if (current != null && current >= target) return; // already provisioned — skip

  const env: Record<string, string> = { EOS_FD_RAISED: "1" };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const argv = [...process.execArgv, ...process.argv.slice(1)].map(q).join(" ");
  const cmd = `ulimit -n ${target} 2>/dev/null; exec ${q(process.execPath)} ${argv}`;

  try {
    execve("/bin/bash", ["bash", "-c", cmd], env);
  } catch {
    // execve unsupported / sandboxed — continue with the inherited limit; better
    // to boot than to abort. The launcher's ulimit (if any) still applies.
  }
}
