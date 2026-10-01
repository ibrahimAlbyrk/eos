// The slash commands Claude Code itself offers in a folder — its bundled skills
// (/design, /code-review, …), claude.ai-synced skills and plugin commands, with
// their descriptions and argument hints. They live inside the binary, so the disk
// scan in routes/commands.ts can't see them: this asks a throwaway SDK process
// (no prompt, so no turn; no hooks; nothing persisted) and caches the answer per
// folder.

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { CommandItem } from "../../../contracts/src/http.ts";

// Built-ins the dashboard already drives with its own controls (sent raw they
// would leave it out of sync), and the ones whose UX needs a terminal.
const HIDDEN_BUILTINS = new Set([
  "clear", "compact", "export", "model", "effort", "fast", "rename", "autocompact",
  "doctor", "color", "focus", "reload-plugins",
]);

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

export type FetchSlashCommands = (cwd: string, env: Record<string, string>) => Promise<SlashCommand[]>;

export interface SdkCommandCatalogDeps {
  /** The child env — Eos's credential store + the focused-session surface, so the
   *  list matches what a focused session can run. */
  buildEnv(): Promise<Record<string, string>>;
  fetchCommands?: FetchSlashCommands;
  now?: () => number;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface SdkCommandCatalog {
  list(cwd: string): Promise<CommandItem[]>;
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

function toItem(c: SlashCommand): CommandItem {
  return {
    name: c.name,
    description: c.description,
    source: c.builtin ? "claude" : "skill",
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
  };
}

export function createSdkCommandCatalog(deps: SdkCommandCatalogDeps): SdkCommandCatalog {
  const fetchCommands = deps.fetchCommands ?? fetchFromSdk;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { items: CommandItem[]; at: number }>();
  const inflight = new Map<string, Promise<CommandItem[]>>();

  const refresh = (cwd: string): Promise<CommandItem[]> => {
    const running = inflight.get(cwd);
    if (running) return running;
    const p = deps.buildEnv()
      .then((env) => fetchCommands(cwd, env))
      .then((commands) => {
        const items = commands
          .filter((c) => !c.name.startsWith("__") && !(c.builtin && HIDDEN_BUILTINS.has(c.name)))
          .map(toItem);
        cache.set(cwd, { items, at: now() });
        return items;
      })
      .catch((e) => {
        deps.log?.warn("listing Claude Code commands failed", { cwd, error: e instanceof Error ? e.message : String(e) });
        return cache.get(cwd)?.items ?? [];
      })
      .finally(() => inflight.delete(cwd));
    inflight.set(cwd, p);
    return p;
  };

  return {
    // A stale entry answers at once and refreshes in the background; only a
    // folder seen for the first time waits for the process.
    async list(cwd) {
      const hit = cache.get(cwd);
      if (!hit) return refresh(cwd);
      if (now() - hit.at > TTL_MS) void refresh(cwd);
      return hit.items;
    },
  };
}
