// A client for `codex app-server`: the shared stdio JSON-RPC transport
// (../stdioRpc.ts) plus Codex's initialize handshake. stderr carries tracing
// logs only.

import { spawnStdioRpc, startupError, type SpawnFn, type StdioRpcClient } from "../stdioRpc.ts";

export type AppServerClient = StdioRpcClient;

export interface AppServerOptions {
  binary: string;
  /** Extra CLI args after `app-server` (e.g. `-c notify=[]`). */
  args?: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  spawnFn?: SpawnFn;
}

export function spawnAppServer(opts: AppServerOptions): AppServerClient {
  return spawnStdioRpc({
    command: opts.binary,
    args: ["app-server", ...(opts.args ?? [])],
    env: opts.env,
    name: "Codex app-server",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
  });
}

// Spawn + the initialize handshake — the only way the rest of Eos opens one.
export async function openAppServer(opts: AppServerOptions): Promise<AppServerClient> {
  const client = spawnAppServer(opts);
  try {
    await client.request("initialize", { clientInfo: { name: "eos", title: "Eos", version: "1.0.0" }, capabilities: null });
  } catch (e) {
    client.close();
    throw startupError("Codex", client, e);
  }
  client.notify("initialized");
  return client;
}
