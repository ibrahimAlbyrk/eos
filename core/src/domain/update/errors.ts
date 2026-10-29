// Every way an update can fail, as one error type. `transient` failures (the
// network, a server hiccup) are worth retrying later; the rest mean the release
// or this install is not fit and retrying the same thing won't help.

export type UpdateErrorCode = "network" | "bad-signature" | "bad-release" | "corrupt" | "disk" | "rejected-bundle";

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }

  get transient(): boolean {
    return this.code === "network" || this.code === "corrupt";
  }
}
