// JSON-RPC over a child's stdio, one JSON object per line — the transport under
// both CLI-driven subscription lanes (Codex's app-server, Gemini's ACP agent).
// No "jsonrpc" field is sent; neither peer requires it. Three message kinds come
// back — responses to our requests ({id, result|error}), notifications ({method,
// params}) and the child's own requests ({id, method, params}: approvals), which
// the owner answers through onRequest. stderr is only kept as a bounded tail to
// explain a crash.

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { errMsg } from "../../contracts/src/util.ts";

type Params = Record<string, unknown>;
type NotificationHandler = (method: string, params: Params) => void;
type RequestHandler = (method: string, params: Params) => Promise<unknown>;

export interface StdioRpcClient {
  request<T = unknown>(method: string, params?: Params): Promise<T>;
  notify(method: string, params?: Params): void;
  onNotification(cb: NotificationHandler): void;
  onRequest(cb: RequestHandler): void;
  onExit(cb: (code: number | null) => void): void;
  /** The last lines the child logged — for a crash message. */
  stderrTail(): string;
  isAlive(): boolean;
  close(): void;
}

export type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined>; cwd?: string }) => ChildProcessWithoutNullStreams;

export interface StdioRpcOptions {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Names the child in error messages ("Codex app-server"). */
  name: string;
  spawnFn?: SpawnFn;
}

const STDERR_TAIL = 4096;

export function spawnStdioRpc(opts: StdioRpcOptions): StdioRpcClient {
  const spawnFn = opts.spawnFn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] }));
  const child = spawnFn(opts.command, opts.args, { env: opts.env, ...(opts.cwd ? { cwd: opts.cwd } : {}) });

  let nextId = 1;
  let alive = true;
  let stderr = "";
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const notificationHandlers: NotificationHandler[] = [];
  const exitHandlers: Array<(code: number | null) => void> = [];
  let requestHandler: RequestHandler | null = null;

  const write = (msg: Record<string, unknown>): void => {
    if (!alive) return;
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const answer = async (id: unknown, method: string, params: Params): Promise<void> => {
    try {
      if (!requestHandler) throw new Error(`no handler for ${method}`);
      write({ id, result: await requestHandler(method, params) });
    } catch (e) {
      write({ id, error: { code: -32603, message: errMsg(e) } });
    }
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = typeof msg.method === "string" ? msg.method : null;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Params;
    if (method && msg.id !== undefined) { void answer(msg.id, method, params); return; }
    if (method) { for (const h of notificationHandlers) h(method, params); return; }
    const waiter = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(msg.id as number);
    const error = msg.error as { message?: string } | undefined;
    if (error) waiter.reject(new Error(error.message ?? `${opts.name} error`));
    else waiter.resolve(msg.result);
  });

  child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-STDERR_TAIL); });
  child.stdin.on("error", () => { /* the exit handler reports the death */ });

  const onGone = (code: number | null): void => {
    if (!alive) return;
    alive = false;
    for (const w of pending.values()) w.reject(new Error(`${opts.name} exited`));
    pending.clear();
    for (const h of exitHandlers) h(code);
  };
  child.on("exit", (code) => onGone(code));
  child.on("error", (e) => {
    stderr = (stderr + `\n${errMsg(e)}`).slice(-STDERR_TAIL);
    onGone(null);
  });

  return {
    request<T>(method: string, params: Params = {}): Promise<T> {
      if (!alive) return Promise.reject(new Error(`${opts.name} is not running`));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        write({ id, method, params });
      });
    },
    notify(method, params) { write(params ? { method, params } : { method }); },
    onNotification(cb) { notificationHandlers.push(cb); },
    onRequest(cb) { requestHandler = cb; },
    onExit(cb) { exitHandlers.push(cb); },
    stderrTail: () => stderr,
    isAlive: () => alive,
    close() {
      if (!alive) return;
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

// Why a handshake failed, with the child's last log line when it left one.
export function startupError(name: string, client: StdioRpcClient, e: unknown): Error {
  const tail = client.stderrTail().trim().split("\n").at(-1);
  return new Error(`${name} didn't start: ${errMsg(e)}${tail ? ` (${tail.slice(0, 200)})` : ""}`, { cause: e });
}
