// Structured stdout/stderr logger. Each log line is one JSON object so logs
// remain grep-friendly and tool-parseable (jq/grep/awk).

import type { Logger } from "../../../core/src/ports/Logger.ts";
import { safeStringify } from "../util/json.ts";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function nowIso(): string {
  return new Date().toISOString();
}

class StructLoggerImpl implements Logger {
  private readonly scope: string;
  private readonly fields: Record<string, unknown>;
  private readonly minLevel: Level;

  constructor(scope: string, fields: Record<string, unknown>, minLevel: Level) {
    this.scope = scope;
    this.fields = fields;
    this.minLevel = minLevel;
  }

  private log(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const line = safeStringify({
      ts: nowIso(),
      level,
      scope: this.scope,
      msg,
      ...this.fields,
      ...(fields ?? {}),
    });
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.log("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log("error", msg, fields); }
  child(fields: Record<string, unknown>): Logger {
    return new StructLoggerImpl(this.scope, { ...this.fields, ...fields }, this.minLevel);
  }
}

export function createLogger(scope: string, level: Level = "info"): Logger {
  // env override — `CLAUDE_MGR_LOG_LEVEL=debug` re-enables debug lines.
  const env = (process.env.CLAUDE_MGR_LOG_LEVEL || "").toLowerCase() as Level;
  const min = env && env in LEVEL_RANK ? env : level;
  return new StructLoggerImpl(scope, {}, min);
}
