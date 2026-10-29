import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFrameApiArtifactSource, NO_TOKEN_MESSAGE, REJECTED_MESSAGE, toArtifactSummary,
} from "../artifacts/FrameApiArtifactSource.ts";

const SLUG = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const SLUG2 = "5d7c1e40-9a1b-4c2d-8e3f-1a2b3c4d5e6f";

// A live row (trimmed to the fields the adapter reads, plus ones it ignores).
const LIVE_ROW = {
  slug: SLUG, title: "Quarterly plan", favicon: "📈", icon: "chart", tint: "violet", type_title: "Docs",
  label: "Draft to legal", live: "v_8f2a", rel: "mine", audience: "owner",
  updatedAt: "2026-10-29T10:00:00.000Z", created_at: "2026-10-20T09:00:00.000Z",
  last_viewed_at: "2026-10-29T10:05:00.000Z", thumbPending: false, softDeleted: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { if (body === undefined) throw new SyntaxError("Unexpected end of JSON input"); return body; },
  } as unknown as Response;
}

interface Seen { url: string; headers: Record<string, string>; signal?: AbortSignal }

function stubFetch(replies: ((s: Seen) => Response)[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const s = { url, headers: init?.headers ?? {}, signal: init?.signal };
    seen.push(s);
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    return reply(s);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("FrameApiArtifactSource", () => {
  it("sends the sign-in's token with the frame headers, and nothing that poses as the CLI", async () => {
    const { fetchImpl, seen } = stubFetch([() => jsonResponse({ frames: [LIVE_ROW] })]);
    const source = createFrameApiArtifactSource({ token: async (id) => (id === "lg-1" ? "tok-1" : null), fetchImpl });
    const rows = await source.list("lg-1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.anthropic.com/api/frame/frames?limit=200");
    assert.deepEqual(seen[0].headers, {
      Authorization: "Bearer tok-1",
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "X-Frame-Surface": "code",
      "X-Frame-CP": "go",
    });
    assert.ok(seen[0].signal, "a timeout rides every request");
    assert.deepEqual(rows, [{
      slug: SLUG,
      url: "https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k",
      title: "Quarterly plan",
      favicon: "📈",
      tint: "violet",
      kind: "Docs",
      version: "v_8f2a",
      versionLabel: "Draft to legal",
      rel: "mine",
      audience: "owner",
      updatedAt: "2026-10-29T10:00:00.000Z",
      createdAt: "2026-10-20T09:00:00.000Z",
      loginId: "lg-1",
    }]);
  });

  it("honours a base URL and combines the caller's signal with its timeout", async () => {
    const { fetchImpl, seen } = stubFetch([() => jsonResponse({ frames: [] })]);
    const ac = new AbortController();
    const source = createFrameApiArtifactSource({ token: async () => "tok", fetchImpl, baseUrl: "http://127.0.0.1:9/" });
    await source.list("lg-1", ac.signal);
    assert.equal(seen[0].url, "http://127.0.0.1:9/api/frame/frames?limit=200");
    assert.equal(seen[0].signal?.aborted, false);
    ac.abort();
    assert.equal(seen[0].signal?.aborted, true);
  });

  it("a rejected token is renewed once, read again and retried once", async () => {
    let token = "old";
    const renewed: string[] = [];
    const { fetchImpl, seen } = stubFetch([
      () => jsonResponse({ error: "expired" }, 401),
      () => jsonResponse({ frames: [LIVE_ROW] }),
    ]);
    const source = createFrameApiArtifactSource({
      token: async () => token,
      renew: async (id) => { renewed.push(id); token = "new"; },
      fetchImpl,
    });
    assert.equal((await source.list("lg-1")).length, 1);
    assert.deepEqual(renewed, ["lg-1"]);
    assert.deepEqual(seen.map((s) => s.headers.Authorization), ["Bearer old", "Bearer new"]);
  });

  it("a second rejection, an unchanged token or a failed renewal says to sign in again", async () => {
    const twice = stubFetch([() => jsonResponse({}, 401), () => jsonResponse({}, 401)]);
    let n = 0;
    const source = createFrameApiArtifactSource({ token: async () => `t${n}`, renew: async () => { n++; }, fetchImpl: twice.fetchImpl });
    await assert.rejects(source.list("lg-1"), { message: REJECTED_MESSAGE });
    assert.equal(twice.seen.length, 2, "retried only once");

    const same = stubFetch([() => jsonResponse({}, 401)]);
    let renews = 0;
    const unchanged = createFrameApiArtifactSource({ token: async () => "t", renew: async () => { renews++; }, fetchImpl: same.fetchImpl });
    await assert.rejects(unchanged.list("lg-1"), { message: REJECTED_MESSAGE });
    assert.equal(renews, 1);
    assert.equal(same.seen.length, 1, "no retry with the token just refused");

    const failing = createFrameApiArtifactSource({
      token: async () => "t", renew: async () => { throw new Error("claude auth login failed"); },
      fetchImpl: stubFetch([() => jsonResponse({}, 401)]).fetchImpl,
    });
    await assert.rejects(failing.list("lg-1"), { message: REJECTED_MESSAGE });

    const noRenew = createFrameApiArtifactSource({ token: async () => "t", fetchImpl: stubFetch([() => jsonResponse({}, 401)]).fetchImpl });
    await assert.rejects(noRenew.list("lg-1"), { message: REJECTED_MESSAGE });
  });

  it("no token is an error saying to sign in again, without a request", async () => {
    const { fetchImpl, seen } = stubFetch([]);
    const source = createFrameApiArtifactSource({ token: async () => null, fetchImpl });
    await assert.rejects(source.list("lg-1"), { message: NO_TOKEN_MESSAGE });
    assert.equal(seen.length, 0);
    assert.match(NO_TOKEN_MESSAGE, /sign in again/);
  });

  it("other failures are short errors naming the status; the token never shows", async () => {
    const source = (reply: () => Response) =>
      createFrameApiArtifactSource({ token: async () => "secret-token", fetchImpl: stubFetch([reply]).fetchImpl });
    await assert.rejects(source(() => jsonResponse({ error: "nope" }, 404)).list("lg-1"), { message: "Couldn't read artifacts (HTTP 404)." });
    await assert.rejects(source(() => jsonResponse({ error: "slow down" }, 429)).list("lg-1"), /HTTP 429/);
    await assert.rejects(source(() => jsonResponse(undefined)).list("lg-1"), /can't read/);
    await assert.rejects(source(() => jsonResponse({ items: [] })).list("lg-1"), /can't read/);
    const down = createFrameApiArtifactSource({
      token: async () => "secret-token",
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    });
    await assert.rejects(down.list("lg-1"), (e: Error) => {
      assert.equal(e.message, "Couldn't reach the artifacts API: fetch failed");
      assert.ok(!e.message.includes("secret-token"));
      return true;
    });
  });

  it("drops soft-deleted, slug-less and malformed rows; fills what a row leaves out", async () => {
    const { fetchImpl } = stubFetch([() => jsonResponse({
      frames: [
        LIVE_ROW,
        { ...LIVE_ROW, slug: SLUG2, softDeleted: true },
        { ...LIVE_ROW, slug: "not-a-uuid" },
        { ...LIVE_ROW, slug: undefined },
        { ...LIVE_ROW, slug: SLUG2, updatedAt: undefined, created_at: undefined },
        null,
        "garbage",
        { slug: SLUG2.toUpperCase(), rel: "something-else", created_at: "2026-10-01T00:00:00Z", title: "  " },
      ],
    })]);
    const rows = await createFrameApiArtifactSource({ token: async () => "t", fetchImpl }).list("lg-2");
    assert.deepEqual(rows.map((r) => r.slug), [SLUG, SLUG2]);
    assert.deepEqual(rows[1], {
      slug: SLUG2,
      url: "https://claude.ai/artifact/CYYhd2Q6dHFw5xpBekVHqY",
      title: "Untitled",
      kind: "Page",
      rel: "mine",
      updatedAt: "2026-10-01T00:00:00Z",
      createdAt: "2026-10-01T00:00:00Z",
      loginId: "lg-2",
    });
  });

  it("maps a shared row as shared", () => {
    assert.equal(toArtifactSummary({ ...LIVE_ROW, rel: "shared" }, "lg-1")?.rel, "shared");
  });
});
