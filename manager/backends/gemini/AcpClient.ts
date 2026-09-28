// A client for the Gemini CLI's Agent Client Protocol server (`gemini --acp`):
// the shared stdio JSON-RPC transport (../stdioRpc.ts) plus ACP's initialize
// handshake. Eos advertises no file-system or terminal capability, so Gemini
// reads, writes and runs commands itself — each write and command still comes
// back first as a session/request_permission request.

import { spawnStdioRpc, startupError, type SpawnFn, type StdioRpcClient } from "../stdioRpc.ts";

export type AcpClient = StdioRpcClient;

export interface AcpOptions {
  binary: string;
  /** Extra CLI args after `--acp`. */
  args?: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  spawnFn?: SpawnFn;
}

const PROTOCOL_VERSION = 1;

export async function openAcpAgent(opts: AcpOptions): Promise<AcpClient> {
  const client = spawnStdioRpc({
    command: opts.binary,
    args: ["--acp", ...(opts.args ?? [])],
    env: opts.env,
    name: "Gemini CLI",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
  });
  try {
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  } catch (e) {
    client.close();
    throw startupError("Gemini", client, e);
  }
  return client;
}
