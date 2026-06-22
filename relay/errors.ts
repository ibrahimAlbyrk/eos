// Relay error codes — protocol §5.5. Cleartext JSON carried in a type=0x06 envelope.

export const RelayError = {
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  BEARER_DENIED: "BEARER_DENIED",
  OWNER_MISMATCH: "OWNER_MISMATCH",
  ROOM_FULL: "ROOM_FULL",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
} as const;
export type RelayErrorCode = (typeof RelayError)[keyof typeof RelayError];

export function errorPayload(code: RelayErrorCode, message: string) {
  return { t: "error", code, message };
}
