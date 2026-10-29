// Asks the feed for the newest release and decides whether it is ours to take:
// signed by our key, meant for this platform, newer than what is installed.

import { UpdatePointerSchema, type UpdatePlatform, type UpdatePointer } from "../../../../contracts/src/update.ts";
import { UpdateError } from "../../domain/update/errors.ts";
import { isNewerVersion } from "../../domain/update/version.ts";
import type { UpdateFeed, UpdateSignature } from "../../ports/Updates.ts";

export interface CheckForUpdateDeps {
  readonly feed: UpdateFeed;
  readonly signature: UpdateSignature;
}

export async function checkForUpdate(
  deps: CheckForUpdateDeps,
  input: { platform: UpdatePlatform; current: string },
): Promise<UpdatePointer | null> {
  const signed = await deps.feed.pointer(input.platform);
  if (!signed) return null;
  if (!deps.signature.verify(signed.payload, signed.signature)) {
    throw new UpdateError("bad-signature", "the release pointer's signature does not verify");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(signed.payload);
  } catch {
    throw new UpdateError("bad-release", "the release pointer is not JSON");
  }
  const parsed = UpdatePointerSchema.safeParse(raw);
  if (!parsed.success) throw new UpdateError("bad-release", "the release pointer is malformed");
  const pointer = parsed.data;
  if (pointer.platform !== input.platform) {
    throw new UpdateError("bad-release", `the release pointer is for ${pointer.platform}, not ${input.platform}`);
  }
  return isNewerVersion(pointer.version, input.current) ? pointer : null;
}
