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
    const raw = parseYaml(readFileSync(p, "utf8"));
    const rawRules: PolicyRule[] = raw?.rules ?? [];
    const compiled: CompiledRule[] = [];
    for (let i = 0; i < rawRules.length; i++) {
      const c = compileRule(rawRules[i], i, p, (m) => opts.log.warn(m));
      if (c) compiled.push(c);
    }
    opts.log.info("policy loaded", { source: p, applied: compiled.length, total: rawRules.length });
    return {
      default: raw?.default ?? "ask",
      ttlMs: raw?.ttlMs ?? opts.defaultTtlMs,
      rules: compiled,
    };
  }
  opts.log.info("no policy file found; default=ask, no rules");
  return { default: "ask", ttlMs: opts.defaultTtlMs, rules: [] };
}
