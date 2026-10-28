import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper } from "../SdkEventMapper.ts";
import { createClaudeSdkBackend, type SdkQueryFn } from "../ClaudeSdkBackend.ts";
import type { AgentLaunchSpec, AgentSession } from "../../../../core/src/ports/AgentBackend.ts";
import type { PlanOutcome } from "../../../../core/src/use-cases/SwitchSessionAccount.ts";

const RESET_S = 1_793_210_400;
const init = { type: "system", subtype: "init", session_id: "sess-1" };
const answer = { type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "half done" }] } };
const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour" } };
const notice = (error: string) =>
  ({ type: "assistant", uuid: "a2", error, message: { id: "m2", model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit · resets 4:40pm" }] } });
const failed = { type: "result", subtype: "success", is_error: true, usage: {} };

const types = (events: AgentEvent[]) => events.map((e) => (e.type === "turn" ? `turn:${e.phase}` : e.type));

describe("SdkEventMapper — a turn its plan sign-in can't run", () => {
  it("holds the CLI's limit notice until the turn ends, then reports the limit and its reset", () => {
    const m = createSdkEventMapper();
    m.map(init as never);
    assert.deepEqual(types(m.map(answer as never)), ["turn:started", "message"]);
    assert.deepEqual(m.map(rejected as never), []);
    assert.deepEqual(types(m.map(notice("rate_limit") as never)), []);
    assert.equal(m.lastAssistantUuid, "a1");
    assert.deepEqual(types(m.map(failed as never)), ["usage", "turn:ended"]);
    const hit = m.takeUnusable();
    assert.deepEqual({ ...hit, notice: types(hit!.notice) }, { reason: "limit", resetsAt: RESET_S * 1000, notice: ["message"] });
    assert.equal(m.takeUnusable(), null);
  });

  it("a rate limit the plan didn't reject is an ordinary failed turn", () => {
    const m = createSdkEventMapper();
    m.map(notice("rate_limit") as never);
    assert.deepEqual(types(m.map(failed as never)), ["message", "usage", "turn:ended"]);
    assert.equal(m.takeUnusable(), null);
  });

  it("a sign-in that stopped working is reported as expired", () => {
    const m = createSdkEventMapper();
    m.map(notice("authentication_failed") as never);
    m.map(failed as never);
    assert.equal(m.takeUnusable()?.reason, "expired");
  });

  it("a limit seen in one turn doesn't carry into the next", () => {
    const m = createSdkEventMapper();
    m.map(rejected as never);
    m.map({ type: "result", subtype: "success", is_error: false, usage: {} } as never);
    m.map(notice("rate_limit") as never);
    m.map(failed as never);
    assert.equal(m.takeUnusable(), null);
  });
});

describe("ClaudeSdkBackend — moving a session to another sign-in", () => {
  function start(onPlanUnusable?: (s: AgentSession, storeDir: string) => Promise<PlanOutcome>, apiKey?: string, credentials: Array<string | null> = []) {
    const launched: Array<{ options: Record<string, unknown>; inputs: unknown[] }> = [];
    const queryFn: SdkQueryFn = (params) => {
      const launch = { options: params.options as unknown as Record<string, unknown>, inputs: [] as unknown[] };
      launched.push(launch);
      void (async () => { for await (const m of params.prompt) launch.inputs.push(m); })();
      const script = launched.length === 1 ? [init, answer, rejected, notice("rate_limit"), failed] : [];
      return Object.assign((async function* () {
        for (const msg of script) yield msg;
        await new Promise(() => {});
      })(), { interrupt: async () => {}, close: () => {} }) as never;
    };
    const events: AgentEvent[] = [];
    let session: AgentSession | null = null;
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], focusedDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
      claudeStore: () => "/acc/claude-p",
      ...(apiKey ? { getAnthropicConfig: () => ({ apiKey }) } : {}),
      onLaunchCredential: (_w: string, dir: string | null) => { credentials.push(dir); },
      ...(onPlanUnusable ? { onPlanUnusable: async (_w: string, hit: { storeDir: string }) => onPlanUnusable(session!, hit.storeDir) } : {}),
    });
    const spec: AgentLaunchSpec = { workerId: "w-s", cwd: "/repo", model: "opus", prompt: "go", persistent: true, parentId: null, isOrchestrator: false };
    const ready = be.start(spec, { onEvent: (e) => events.push(e) }).then((s) => { session = s; return s; });
    return { ready, launched, events };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const storeOf = (launch: { options: Record<string, unknown> }) => (launch.options.env as Record<string, string>).CLAUDE_SECURESTORAGE_CONFIG_DIR;

  it("asks the daemon, resumes the same session on the new store and drops the failed turn's end", async () => {
    const asked: string[] = [];
    const t = start(async (s, storeDir) => {
      asked.push(storeDir);
      assert.equal((await s.switchAccount!({ storeDir: "/acc/claude-w" })).ok, true);
      return "switched";
    });
    const s = await t.ready;
    await settle();
    assert.deepEqual(asked, ["/acc/claude-p"]);
    assert.equal(s.capabilities.accountSwitch, true);
    assert.equal(t.launched.length, 2);
    assert.equal(storeOf(t.launched[0]), "/acc/claude-p");
    assert.equal(storeOf(t.launched[1]), "/acc/claude-w");
    assert.equal(t.launched[1].options.resume, "sess-1");
    assert.equal(t.events.some((e) => e.type === "turn" && e.phase === "ended"), false);
    assert.equal(t.events.filter((e) => e.type === "message").length, 1);
  });

  it("without a switch the turn ends as it did, the CLI's notice included", async () => {
    const t = start(async () => "kept");
    await t.ready;
    await settle();
    assert.equal(t.launched.length, 1);
    assert.deepEqual(types(t.events).slice(-3), ["message", "usage", "turn:ended"]);
  });

  it("when the daemon recorded that every account is out, the CLI's notice is dropped", async () => {
    const t = start(async () => "exhausted");
    await t.ready;
    await settle();
    assert.deepEqual(types(t.events).slice(-2), ["usage", "turn:ended"]);
    assert.equal(t.events.filter((e) => e.type === "message").length, 1);
  });

  it("on the API key the launch bills the key, with no OAuth token beside it", async () => {
    const credentials: Array<string | null> = [];
    const t = start(async (s) => {
      assert.equal((await s.switchAccount!({ apiKey: true })).ok, true);
      return "switched";
    }, "sk-ant-1", credentials);
    const s = await t.ready;
    await settle();
    s.stop();
    assert.deepEqual(credentials, ["/acc/claude-p", null, null]);
    const env = t.launched[1].options.env as Record<string, string>;
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-1");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  it("refuses the API key when none is set", async () => {
    let refused: { ok: boolean; reason?: string } | null = null;
    const t = start(async (s) => { refused = await s.switchAccount!({ apiKey: true }); return "kept"; });
    await t.ready;
    await settle();
    assert.deepEqual(refused, { ok: false, reason: "no API key is set" });
    assert.equal(t.launched.length, 1);
  });
});
