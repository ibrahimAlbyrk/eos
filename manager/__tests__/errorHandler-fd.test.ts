import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";

import { handleError } from "../middleware/errorHandler.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

const noop = (): void => {};
const log: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };

function capture(): { res: ServerResponse; out: { status?: number; body?: { error: string; code?: string } } } {
  const out: { status?: number; body?: { error: string; code?: string } } = {};
  const res = {
    req: { headers: {} },
    writeHead: (status: number) => { out.status = status; },
    end: (json: string) => { out.body = JSON.parse(json); },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("handleError fd exhaustion", () => {
  it("maps spawn EBADF to 503 without suggesting a ulimit raise", () => {
    // On macOS raising ulimit can't help: posix_spawn rejects fds ≥ 10240 regardless.
    const { res, out } = capture();
    const e = Object.assign(new Error("spawn EBADF"), { code: "EBADF" });
    handleError(res, e, { requestId: "r-1", method: "POST", path: "/orchestrators", log });
    assert.equal(out.status, 503);
    assert.equal(out.body?.code, "EBADF");
    assert.match(out.body!.error, /fds open/);
    assert.doesNotMatch(out.body!.error, /ulimit/);
  });
});
