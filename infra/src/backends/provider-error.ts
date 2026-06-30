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
