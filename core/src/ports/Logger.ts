// Logger port — structured logging interface. Adapter is StructLogger in
// infra/observability/. Use `child(fields)` to attach request-id /
// worker-id context for the lifetime of a request.

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
