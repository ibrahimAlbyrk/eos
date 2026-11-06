// The slash commands Claude Code itself offers in a folder — its bundled skills
// (/design, /code-review, …), claude.ai-synced skills and plugin commands, with
// their descriptions and argument hints. They live inside the binary, so the disk
// scan in routes/commands.ts can't see them. Every focused session reports the
// list for its folder when it starts (seed); only a folder no session has reported
// yet asks a throwaway SDK process (no prompt, so no turn; no hooks; nothing
// persisted). The lists are kept on disk, so a daemon restart starts warm.

import { readFileSync } from "node:fs";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { CommandItem } from "../../../contracts/src/http.ts";
import { writeFileAtomic } from "../../../infra/src/persistence/atomic-file.ts";

// Built-ins the dashboard already drives with its own controls (sent raw they
// would leave it out of sync), and the ones whose UX needs a terminal.
const HIDDEN_BUILTINS = new Set([
  "clear", "compact", "export", "model", "effort", "fast", "rename", "autocompact",
  "doctor", "color", "focus", "reload-plugins", "btw",
]);

const TIMEOUT_MS = 8_000;

export type FetchSlashCommands = (cwd: string, env: Record<string, string>) => Promise<SlashCommand[]>;

// Folder → its command list, kept between daemon runs.
export interface CommandListStore {
  read(): Record<string, CommandItem[]>;
  write(lists: Record<string, CommandItem[]>): void;
}

export interface SdkCommandCatalogDeps {
  /** The child env — Eos's credential store + the focused-session surface, so the
   *  list matches what a focused session can run. */
  buildEnv(): Promise<Record<string, string>>;
  fetchCommands?: FetchSlashCommands;
  store?: CommandListStore;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface SdkCommandCatalog {
  list(cwd: string): Promise<CommandItem[]>;
  /** A focused session in `cwd` started and listed its commands. */
  seed(cwd: string, commands: SlashCommand[]): void;
}

const fetchFromSdk: FetchSlashCommands = async (cwd, env) => {
  // Never yields: the process starts, answers the initialize request, and is closed.
  const prompt: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
  const q = realQuery({
    prompt,
    options: {
      cwd, env,
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: true },
      persistSession: false,
    } as Options,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out listing Claude Code commands")), TIMEOUT_MS);
    });
    return (await Promise.race([q.initializationResult(), timeout])).commands;
  } finally {
    clearTimeout(timer);
    q.close();
  }
};

export function fileCommandListStore(path: string): CommandListStore {
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, CommandItem[]> : {};
      } catch {
        return {};
      }
    },
    write(lists) { writeFileAtomic(path, JSON.stringify(lists)); },
  };
}

function toItems(commands: SlashCommand[]): CommandItem[] {
  return commands
    .filter((c) => !c.name.startsWith("__") && !(c.builtin && HIDDEN_BUILTINS.has(c.name)))
    .map((c) => ({
      name: c.name,
      description: c.description,
      source: c.builtin ? "claude" : "skill",
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    }));
}

export function createSdkCommandCatalog(deps: SdkCommandCatalogDeps): SdkCommandCatalog {
  const fetchCommands = deps.fetchCommands ?? fetchFromSdk;
  const cache = new Map<string, CommandItem[]>(Object.entries(deps.store?.read() ?? {}));
  const inflight = new Map<string, Promise<CommandItem[]>>();

  const keep = (cwd: string, items: CommandItem[]): void => {
    if (JSON.stringify(cache.get(cwd)) === JSON.stringify(items)) return;
    cache.set(cwd, items);
    try { deps.store?.write(Object.fromEntries(cache)); }
    catch (e) { deps.log?.warn("saving Claude Code commands failed", { error: e instanceof Error ? e.message : String(e) }); }
  };

  const fetchFor = (cwd: string): Promise<CommandItem[]> => {
    const running = inflight.get(cwd);
    if (running) return running;
    const p = deps.buildEnv()
      .then((env) => fetchCommands(cwd, env))
      .then((commands) => {
        const items = toItems(commands);
        keep(cwd, items);
        return items;
      })
      .catch((e) => {
        deps.log?.warn("listing Claude Code commands failed", { cwd, error: e instanceof Error ? e.message : String(e) });
        return [];
      })
      .finally(() => inflight.delete(cwd));
    inflight.set(cwd, p);
    return p;
  };

  return {
    async list(cwd) {
      return cache.get(cwd) ?? fetchFor(cwd);
    },
    seed(cwd, commands) {
      keep(cwd, toItems(commands));
    },
  };
}
