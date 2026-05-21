// Tiny structured logger. Each line: ISO timestamp · level · component · msg
// followed by JSON-encoded structured fields (if any).
//
// Why not pino/winston: the manager runs as a long-lived local daemon, not as
// a fleet, and pulling in a 200-file dep tree for log formatting is overkill.
// This module is ~50 lines, hand-traceable, and depends on nothing.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentMinLevel(): LogLevel {
  const raw = (process.env.CLAUDE_MGR_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const minRank = LEVEL_RANK[currentMinLevel()];

function format(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const head = `${ts} ${level.padEnd(5)} [${component}] ${msg}`;
  if (!fields || Object.keys(fields).length === 0) return head;
  try { return `${head} ${JSON.stringify(fields)}`; }
  catch { return head; }
}

function emit(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < minRank) return;
  const line = format(level, component, msg, fields);
  // warn/error → stderr, info/debug → stdout. Matches typical pipe expectations
  // for log shippers and lets `2>&1 | grep ERROR` work intuitively.
  if (level === "warn" || level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

/** A logger bound to a component name. Use `createLogger("daemon")` etc. */
export function createLogger(component: string) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", component, msg, fields),
    info:  (msg: string, fields?: Record<string, unknown>) => emit("info",  component, msg, fields),
    warn:  (msg: string, fields?: Record<string, unknown>) => emit("warn",  component, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", component, msg, fields),
    /** Child logger with extra default fields merged into every line. */
    child(extra: Record<string, unknown>) {
      const merge = (fields?: Record<string, unknown>) => ({ ...extra, ...(fields ?? {}) });
      return {
        debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", component, msg, merge(fields)),
        info:  (msg: string, fields?: Record<string, unknown>) => emit("info",  component, msg, merge(fields)),
        warn:  (msg: string, fields?: Record<string, unknown>) => emit("warn",  component, msg, merge(fields)),
        error: (msg: string, fields?: Record<string, unknown>) => emit("error", component, msg, merge(fields)),
      };
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
