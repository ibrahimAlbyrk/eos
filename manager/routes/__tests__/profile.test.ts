import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerProfileRoutes } from "../profile.ts";
import type { Container } from "../../container.ts";
import { UserProfileService } from "../../../core/src/services/UserProfileService.ts";
import { buildUserProfileBlock } from "../../../core/src/use-cases/BuildUserProfileBlock.ts";
import type { UserAvatar } from "../../../core/src/ports/UserProfileStore.ts";
import type { UserProfile } from "../../../contracts/src/profile.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const UI = { "x-eos-ui-token": "tok" };

function makeContainer() {
  let saved: UserProfile | null = null;
  let avatar: UserAvatar | null = null;
  const profile = new UserProfileService({
    store: { get: () => saved, put: (p) => { saved = p; } },
    avatars: { read: () => avatar, write: (a) => { avatar = a; }, remove: () => { avatar = null; } },
    clock: { now: () => 1 },
    bus: { publish: () => {} },
  });
  return {
    uiToken: "tok",
    profile,
    userProfilePreview: (kind: string, project: string | null) =>
      buildUserProfileBlock({ profile, memories: () => [] }, { kind, project, knownLines: [], searchToolName: null }),
    readUserClaudeMd: () => ({ path: "/u/.claude/CLAUDE.md", text: "Be terse." }),
  } as unknown as Container;
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerProfileRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route matched ${u.pathname}`);
  const chunk = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {}));
  const req = Object.assign(Readable.from([chunk]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let head: Record<string, string> = {};
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number, h?: Record<string, string>) => { status = s; head = h ?? {}; },
    end: (b?: string | Buffer) => {
      payload = typeof b === "string" ? JSON.parse(b) : b;
    },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, head, payload: payload as Record<string, any> };
}

describe("profile routes", () => {
  it("anyone reads; only the UI token writes", async () => {
    const c = makeContainer();
    assert.equal((await call(c, "GET", "/api/profile")).payload.profile.rev, 0);
    const denied = await call(c, "PUT", "/api/profile", { patch: { identity: { callName: "X" } } });
    assert.equal(denied.status, 403);
    const ok = await call(c, "PUT", "/api/profile", { patch: { identity: { callName: "Ibrahim" } } }, UI);
    assert.equal(ok.status, 200);
    assert.equal(ok.payload.profile.identity.callName, "Ibrahim");
  });

  it("a stale baseRev answers 409 with the current profile", async () => {
    const c = makeContainer();
    await call(c, "PUT", "/api/profile", { patch: { instructions: "a" }, baseRev: 0 }, UI);
    const r = await call(c, "PUT", "/api/profile", { patch: { instructions: "b" }, baseRev: 0 }, UI);
    assert.equal(r.status, 409);
    assert.equal(r.payload.profile.instructions, "a");
  });

  it("preview reports the real block and whether the kind is withheld", async () => {
    const c = makeContainer();
    await call(c, "PUT", "/api/profile", { patch: { identity: { callName: "Ibrahim" }, sharing: { withholdFrom: ["gemini-cli"] } } }, UI);
    const claude = await call(c, "GET", "/api/profile/preview?kind=claude");
    assert.match(claude.payload.text, /Address the user as "Ibrahim"/);
    assert.equal(claude.payload.withheld, false);
    const gemini = await call(c, "GET", "/api/profile/preview?kind=gemini-cli");
    assert.equal(gemini.payload.withheld, true);
    assert.match(gemini.payload.text, /user_preferences/);
  });

  it("avatar: upload needs the token, is served with its mime, and clears", async () => {
    const c = makeContainer();
    assert.equal((await call(c, "PUT", "/api/profile/avatar", PNG)).status, 403);
    const up = await call(c, "PUT", "/api/profile/avatar", PNG, UI);
    assert.equal(up.payload.profile.identity.avatar, "png");
    const got = await call(c, "GET", "/api/profile/avatar");
    assert.equal(got.status, 200);
    assert.equal(got.head["content-type"], "image/png");
    await call(c, "DELETE", "/api/profile/avatar", undefined, UI);
    assert.equal((await call(c, "GET", "/api/profile/avatar")).status, 404);
  });

  it("CLAUDE.md import is token-gated", async () => {
    const c = makeContainer();
    assert.equal((await call(c, "GET", "/api/profile/import/claude-md")).status, 403);
    assert.equal((await call(c, "GET", "/api/profile/import/claude-md", undefined, UI)).payload.text, "Be terse.");
  });
});
