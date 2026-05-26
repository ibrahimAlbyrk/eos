// YAML policy loader. Pure infra — reads file off disk, parses YAML,
// compiles each rule via the core/domain/policy engine.

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { compileRule, type Policy, type PolicyRule, type CompiledRule } from "../../../core/src/domain/policy.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

export interface PolicyLoadOptions {
  candidates: string[];   // tried in order; first existing wins
  defaultTtlMs: number;
  log: Logger;
}

export function loadPolicy(opts: PolicyLoadOptions): Policy {
  for (const p of opts.candidates) {
    if (!existsSync(p)) continue;
    let raw: Record<string, unknown> | null;
    try {
      raw = parseYaml(readFileSync(p, "utf8")) as Record<string, unknown> | null;
    } catch (e) {
      opts.log.warn("failed to parse policy file", { source: p, error: (e as Error).message });
      return { default: "ask" as const, ttlMs: opts.defaultTtlMs, rules: [] };
    }
    const rawRules: PolicyRule[] = (raw?.rules ?? []) as PolicyRule[];
    const compiled: CompiledRule[] = [];
    for (let i = 0; i < rawRules.length; i++) {
      const c = compileRule(rawRules[i], i, p, (m) => opts.log.warn(m));
      if (c) compiled.push(c);
    }
    opts.log.info("policy loaded", { source: p, applied: compiled.length, total: rawRules.length });
    return {
      default: (raw?.default as string) ?? "ask",
      ttlMs: (raw?.ttlMs as number) ?? opts.defaultTtlMs,
      rules: compiled,
    };
  }
  opts.log.info("no policy file found; default=ask, no rules");
  return { default: "ask", ttlMs: opts.defaultTtlMs, rules: [] };
}
