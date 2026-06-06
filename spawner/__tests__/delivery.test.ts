import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DeliveryPipeline,
  normalizeForMatch,
  PASTE_START,
  type DeliveryPipelineOptions,
  type DeliveryResult,
} from "../delivery.ts";

// Real timers with small windows — the pipeline is promise-driven, so a few
// tens of milliseconds per stage keeps the suite fast without fake clocks.
// Ack windows are generous relative to the echo/CR stages so a loaded CI box
// can't flake the ordering assertions.
const FAST = {
  ackMs: 150,
  retryAckMs: 60,
  echoCeilingMs: 30,
  postEchoMs: 1,
  postCrMs: 1,
  escMs: 1,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  pipeline: DeliveryPipeline;
  writes: string[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  phases(): string[];
  pastes(): number;
}

function makeHarness(over: Partial<DeliveryPipelineOptions> = {}): Harness {
  const writes: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const pipeline = new DeliveryPipeline({
    write: (s) => { writes.push(s); },
    emit: (type, payload) => { events.push({ type, payload: payload as Record<string, unknown> }); },
    canVerifyAck: () => true,
    isTurnActive: () => false,
    fallbackCrDelayMs: 10,
    timeouts: FAST,
    ...over,
  });
  return {
    pipeline, writes, events,
    phases: () => events.map((e) => e.payload.phase as string),
    pastes: () => writes.filter((w) => w.startsWith(PASTE_START)).length,
  };
}

// enqueue() starts its cycle on a microtask — give the paste a moment to land
// before feeding echo bytes, like the real PTY would.
async function start(h: Harness, text: string): Promise<{ p: Promise<DeliveryResult> }> {
  // Wrapped in an object — returning the bare promise from an async helper
  // would flatten it, making `await start(...)` wait for the whole delivery.
  const p = h.pipeline.enqueue(text);
  await sleep(2);
  return { p };
}

const TEXT = "fix the login bug in auth.ts please";

describe("normalizeForMatch", () => {
  it("strips ANSI sequences, whitespace and composer box-drawing", () => {
    const raw = "\x1b[38;5;246m╭─\x1b[39m fix the \n│ login\x1b[0m bug";
    assert.equal(normalizeForMatch(raw), "fixtheloginbug");
  });

  it("keeps regular punctuation and non-box unicode intact", () => {
    assert.equal(normalizeForMatch("a>b/c.d—é"), "a>b/c.d—é");
  });
});

describe("DeliveryPipeline", () => {
  it("happy path: paste → echo → CR → ACK resolves delivered", async () => {
    const h = makeHarness();
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput(`╭───╮\n│ \x1b[1m${TEXT}\x1b[0m │`);
    await sleep(5);
    h.pipeline.notifyUserText(TEXT, Date.now());
    const res = await p;
    assert.equal(res.outcome, "delivered");
    assert.equal(res.attempts, 1);
    assert.ok(h.writes[0].startsWith(PASTE_START));
    assert.equal(h.writes[1], "\r");
    assert.deepEqual(h.phases(), ["prompt_delivered"]);
  });

  it("echo seen → CR goes out without waiting the fallback delay", async () => {
    const h = makeHarness({ fallbackCrDelayMs: 5000, timeouts: { ...FAST, echoCeilingMs: 5000 } });
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput(TEXT);
    await sleep(20);
    assert.equal(h.writes[1], "\r"); // CR already written — no 5s blind wait
    h.pipeline.notifyUserText(TEXT, Date.now());
    await p;
  });

  it("echo split across chunks with wrapping borders still matches", async () => {
    const h = makeHarness();
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput("│ fix the login ");
    h.pipeline.feedOutput("│\n│ bug in auth");
    h.pipeline.feedOutput(".ts please │");
    await sleep(5);
    h.pipeline.notifyUserText(TEXT, Date.now());
    const res = await p;
    assert.equal(res.outcome, "delivered");
  });

  it("large paste collapsed to the [Pasted text …] placeholder still echo-matches", async () => {
    const big = "line\n".repeat(400);
    const h = makeHarness();
    const { p } = await start(h, big);
    h.pipeline.feedOutput("│ [Pasted text #1 +400 lines] │");
    await sleep(5);
    h.pipeline.notifyUserText(big, Date.now());
    const res = await p;
    assert.equal(res.outcome, "delivered");
  });

  it("echo timeout falls back to the fixed CR delay and emits echo_timeout", async () => {
    const h = makeHarness();
    const { p } = await start(h, TEXT);
    await sleep(60); // > echo ceiling + fallback delay
    assert.equal(h.writes[1], "\r");
    h.pipeline.notifyUserText(TEXT, Date.now());
    const res = await p;
    assert.equal(res.outcome, "delivered");
    assert.ok(h.phases().includes("echo_timeout"));
  });

  it("echo OK + no ACK → exactly one re-CR, then unverified (never re-paste)", async () => {
    const h = makeHarness();
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput(TEXT); // echo ok, no ack ever
    const res = await p;
    assert.equal(res.outcome, "unverified");
    assert.equal(h.pastes(), 1);
    assert.equal(h.writes.filter((w) => w === "\r").length, 2); // original + re-CR
    assert.deepEqual(h.phases(), ["delivery_retry", "delivery_unverified"]);
  });

  it("no echo + no ACK → Esc + re-paste up to 3 attempts, then delivery_failed", async () => {
    const h = makeHarness();
    const res = await h.pipeline.enqueue(TEXT);
    assert.equal(res.outcome, "failed");
    assert.equal(res.attempts, 3);
    assert.equal(h.pastes(), 3);
    assert.equal(h.writes.filter((w) => w === "\x1b").length, 2);
    assert.equal(h.phases().filter((ph) => ph === "delivery_failed").length, 1);
  });

  it("retry paste that echoes but never ACKs resolves unverified (no third paste)", async () => {
    const h = makeHarness();
    const { p } = await start(h, TEXT);
    // First attempt: no echo. Once the second paste lands (after Esc), feed it.
    const feeder = setInterval(() => {
      if (h.pastes() === 2) {
        h.pipeline.feedOutput(TEXT);
        clearInterval(feeder);
      }
    }, 2);
    const res = await p;
    clearInterval(feeder);
    assert.equal(res.outcome, "unverified");
    assert.equal(h.pastes(), 2);
  });

  it("mid-turn steer: ACK skipped, single attempt, outcome 'sent'", async () => {
    const h = makeHarness({ isTurnActive: () => true });
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput(TEXT);
    const res = await p;
    assert.equal(res.outcome, "sent");
    assert.equal(res.attempts, 1);
    assert.deepEqual(h.phases(), []); // no verification noise for steers
  });

  it("no tail yet (canVerifyAck=false): outcome 'sent' without retries", async () => {
    const h = makeHarness({ canVerifyAck: () => false });
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput(TEXT);
    const res = await p;
    assert.equal(res.outcome, "sent");
    assert.equal(h.pastes(), 1);
  });

  it("tiny text (below needle minimum): single attempt, unverified on ACK miss", async () => {
    const h = makeHarness();
    const res = await h.pipeline.enqueue("ok");
    assert.equal(res.outcome, "unverified");
    assert.equal(h.pastes(), 1);
  });

  it("slash command ACK matches transcript's <command-name> XML wrapping", async () => {
    const h = makeHarness();
    const { p } = await start(h, "/commit all staged changes");
    h.pipeline.feedOutput("/commit all staged changes");
    await sleep(5);
    h.pipeline.notifyUserText(
      "<command-name>/commit</command-name><command-args>all staged changes</command-args>",
      Date.now(),
    );
    const res = await p;
    assert.equal(res.outcome, "delivered");
  });

  it("ACK arriving before the wait window registers is caught via the ring", async () => {
    const h = makeHarness();
    const { p } = await start(h, TEXT);
    h.pipeline.feedOutput(TEXT);
    // Ack lands before the post-echo settle finishes — only the ring sees it.
    h.pipeline.notifyUserText(TEXT, Date.now());
    const res = await p;
    assert.equal(res.outcome, "delivered");
  });

  it("serializes deliveries: second paste only after the first cycle resolves", async () => {
    const h = makeHarness();
    const p1 = h.pipeline.enqueue("first message text");
    const p2 = h.pipeline.enqueue("second message text");
    await sleep(2);
    h.pipeline.feedOutput("first message text");
    await sleep(5);
    assert.equal(h.pastes(), 1); // second delivery still queued
    h.pipeline.notifyUserText("first message text", Date.now());
    await p1;
    await sleep(5);
    h.pipeline.feedOutput("second message text");
    await sleep(5);
    h.pipeline.notifyUserText("second message text", Date.now());
    const res2 = await p2;
    assert.equal(res2.outcome, "delivered");
    assert.equal(h.pastes(), 2);
  });

  it("write errors resolve 'failed' without poisoning the chain", async () => {
    let calls = 0;
    const h = makeHarness({
      write: () => { calls += 1; if (calls === 1) throw new Error("EIO"); },
    });
    const res1 = await h.pipeline.enqueue(TEXT);
    assert.equal(res1.outcome, "failed");
    const p2 = h.pipeline.enqueue("second message text");
    await sleep(2);
    h.pipeline.feedOutput("second message text");
    await sleep(5);
    h.pipeline.notifyUserText("second message text", Date.now());
    const res2 = await p2;
    assert.equal(res2.outcome, "delivered");
  });
});
