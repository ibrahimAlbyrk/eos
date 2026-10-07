import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { TransferRecord } from "../../../contracts/src/transfer.ts";
import { formatBytes } from "../../../core/src/domain/transfer.ts";

// How long the call follows the copy before handing it to the background — a
// long single HTTP wait would hit the MCP and undici ceilings (ask_user polls too).
const WAIT_MS = 60_000;
const POLL_MS = 1_500;
const ACTIVE = new Set<TransferRecord["status"]>(["queued", "scanning", "copying", "conflict", "committing"]);

export const sendToMachineDef: ToolDefinition = {
  name: "send_to_machine",
  visibility: "worker",
  inputSchema: {
    machine: z.string().min(1).max(200).describe("The paired Mac to send to, by the name the user used — e.g. \"MacBook Air\"."),
    paths: z.array(z.string().min(1)).min(1).max(100).describe("Files or folders on this Mac: absolute, or relative to your working folder."),
  },
  handler: async (ctx, args) => {
    const machine = String(args.machine);
    const started = (await call(() => ctx.api("POST", ROUTES.workerTransfers(ctx.selfId), args))) as TransferRecord;
    const deadline = Date.now() + WAIT_MS;
    let t = started;
    while (ACTIVE.has(t.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        t = (await ctx.api("GET", ROUTES.workerTransfer(ctx.selfId, started.id))) as TransferRecord;
      } catch {
        // a blip — the next poll tells
      }
    }
    // The id lets the transcript card follow the transfer after this returns.
    const tag = `(${t.id})`;
    const what = t.roots.map((r) => r.name).join(", ") || started.sources.join(", ");
    if (t.status === "done") {
      const where = t.placed.map((p) => p.path).join(", ");
      return `Sent ${what} (${formatBytes(t.totalBytes)}) to ${machine}: ${where} ${tag}`;
    }
    if (ACTIVE.has(t.status)) {
      const pct = t.totalBytes ? Math.floor((t.doneBytes * 100) / t.totalBytes) : 0;
      return `Still copying ${what} to ${machine} (${pct}%). It finishes in the background — the user sees it in the Transfer tab and gets a notification. ${tag}`;
    }
    if (t.status === "paused" || t.status === "interrupted") {
      return `The copy to ${machine} stopped part-way (${t.status}) — the user can resume it from the Transfer tab. ${tag}`;
    }
    if (t.status === "cancelled") return `The user cancelled sending ${what}. ${tag}`;
    throw new Error(`Sending ${what} to ${machine} failed: ${t.error?.message ?? "unknown error"} ${tag}`);
  },
};

// The daemon's own reason ("No paired Mac matches …") rather than its raw reply.
async function call<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw new Error(reasonOf(e), { cause: e });
  }
}

function reasonOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const body = /^daemon \d+: (.*)$/s.exec(msg)?.[1];
  try {
    const err = (JSON.parse(body ?? "") as { error?: unknown }).error;
    if (typeof err === "string") return err.replace(/^invalid request: /, "");
  } catch {
    // not the daemon's JSON — keep the message as it is
  }
  return msg;
}
