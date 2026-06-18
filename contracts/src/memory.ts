import { z } from "zod";

// A memory source — a CLAUDE.md / AGENTS.md-style instruction-file family,
// configured under config.memory.sources (keyed by id). Every field is optional
// at the config layer; resolveMemorySources (core) fills the defaults. The repo
// ships exactly one source (`claude`); a user adds others (e.g. AGENTS.md) by
// dropping an entry in ~/.eos/config.json — no code change.
//
// `assumeNativeFor` lists the backend kinds that load this source THEMSELVES (the
// claude-cli binary auto-loads CLAUDE.md), so Eos skips injecting it for them and
// never feeds a backend its own memory twice.
export const MemorySourceSchema = z
  .object({
    enabled: z.boolean(),
    label: z.string(),
    userPaths: z.array(z.string()),         // global: "~/.claude/CLAUDE.md" | absolute path
    projectFilenames: z.array(z.string()),  // local: names walked from cwd up to the repo root
    priority: z.number(),                    // ordering in the composed prompt (lower first)
    assumeNativeFor: z.array(z.string()),    // backend kinds that load this source natively
  })
  .partial();
export type MemorySourceSpec = z.infer<typeof MemorySourceSchema>;

// A resolved source: the config key folded in as `id`, defaults applied.
export interface MemorySource {
  readonly id: string;
  readonly label: string;
  readonly userPaths: readonly string[];
  readonly projectFilenames: readonly string[];
  readonly priority: number;
  readonly assumeNativeFor: readonly string[];
}
