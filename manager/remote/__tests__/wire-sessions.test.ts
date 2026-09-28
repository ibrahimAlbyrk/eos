// Daemon-side session lifecycle against a mock relay: a relay `left` disposes
// that device's session at once, and a fresh relay socket (re-register) drops
// every session joined through the previous one. Observed from the relay side:
// a live session receives the bus fan-out, a disposed one receives nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import { startRemoteGateway, type RemoteWiringDeps } from "../wire.ts";
import { encodeJsonEnvelope, parseEnvelope, FrameType, Dir } from "../envelope.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

class TopicBus implements EventBus {
  private subs = new Map<string, EventBusSubscriber[]>();
  publish(topic: EventBusTopic, payload: unknown): void {
    for (const fn of [...(this.subs.get(topic) ?? []), ...(this.subs.get("*") ?? [])]) fn({ topic, payload, ts: 0 });
  }
  subscribe(topic: EventBusTopic | "*", fn: EventBusSubscriber): () => void {
    this.subs.set(topic, [...(this.subs.get(topic) ?? []), fn]);
    return () => { this.subs.set(topic, (this.subs.get(topic) ?? []).filter((f) => f !== fn)); };
  }
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

describe("remote wiring — relay-driven session lifecycle", () => {
  it("disposes a session on `left` and every session on re-register", async () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-sess-"));
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as AddressInfo).port)));
    let mac: WebSocket | null = null;
    let registers = 0;
    const dataFor = new Map<string, number>(); // clientId hex → s2c data frames seen
    wss.on("connection", (ws) => {
      mac = ws;
      ws.on("message", (raw) => {
        const env = parseEnvelope(raw as Buffer);
        if (env.type === FrameType.register) registers++;
        if (env.type === FrameType.data) {
          const hex = env.clientId.toString("hex");
          dataFor.set(hex, (dataFor.get(hex) ?? 0) + 1);
        }
      });
    });

    const bus = new TopicBus();
    const deps: RemoteWiringDeps = {
      config: { remote: { enabled: true, relay: { url: `ws://127.0.0.1:${port}/` } }, daemon: { home, port: 7400 } },
      uiToken: "tok", bus, log: { info() {}, warn() {} },
    };
    const handle = startRemoteGateway(deps, {} as never);
    try {
      await waitFor(() => registers === 1);
      const room = "R";
      const relayctl = (json: Record<string, unknown>) =>
        mac!.send(encodeJsonEnvelope({ type: FrameType.relayctl, room, dir: Dir.s2c, json }));
      const a = Buffer.alloc(16, 0xaa);
      const b = Buffer.alloc(16, 0xbb);
      relayctl({ t: "joined", clientId: a.toString("base64url") });
      relayctl({ t: "joined", clientId: b.toString("base64url") });
      await new Promise((r) => setTimeout(r, 20));

      const fanOut = () => bus.publish("agent:delta", { workerId: "w", blockId: "x", phase: "append", text: "." });
      fanOut();
      await waitFor(() => (dataFor.get(a.toString("hex")) ?? 0) === 1 && (dataFor.get(b.toString("hex")) ?? 0) === 1);

      relayctl({ t: "left", clientId: a.toString("base64url") });
      await new Promise((r) => setTimeout(r, 20));
      fanOut();
      await waitFor(() => (dataFor.get(b.toString("hex")) ?? 0) === 2);
      assert.equal(dataFor.get(a.toString("hex")), 1, "a left ⇒ no more fan-out to it");

      // Relay-side socket drops → connector redials (1s backoff) and re-registers.
      mac!.terminate();
      await waitFor(() => registers === 2);
      await new Promise((r) => setTimeout(r, 20));
      fanOut();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(dataFor.get(b.toString("hex")), 2, "re-register ⇒ sessions from the old socket are gone");
    } finally {
      handle!.stop();
      await new Promise<void>((r) => wss.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
