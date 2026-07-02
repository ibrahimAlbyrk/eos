// ProviderErrorInfo — the typed signal the two model clients hand to an injected
// onProviderError sink on the diagnosable failure paths (m5 observability): a
// round-trip HTTP error (after retries) or a network/connection refusal (keyless
// localhost down). The composition root wires the sink to a structured log
// (backend + model + workerId + status), so a multi-provider misconfig is
// diagnosable instead of collapsing into a generic turn:error.
export interface ProviderErrorInfo {
  transport: "http" | "network";
  status?: number;
  detail?: string;
}

// Typed error strings for billing/auth turn failures, shared by BOTH model clients
// (the per-provider HTTP classification differs; the STRING values are the contract).
// ToolRuntime forwards these verbatim as the turn:error reason, and the UI's
// messageParser maps them to human English — the same-value contract must hold on
// both sides. Kept alongside the existing "context_window_exceeded" typed code.
export const INSUFFICIENT_CREDITS = "insufficient_credits";
export const AUTH_INVALID = "auth_invalid";
