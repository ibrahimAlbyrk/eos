// Milestone proof: an in-process "device" (using crypto.ts) completes a cold
// SIGMA pairing through the server state machine, then drives one control
// round-trip per tier through the dispatch shim — READ ok, HIGH without step-up
// → STEPUP_REQUIRED, /stepup/challenge → sign → HIGH ok, REFUSED → ROUTE_REFUSED
// — over the real AEAD record codec. No WS/relay transport needed; this is the
// gateway core end-to-end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";

import {
  hash, keyedHash, kdf, kxKeypair, kxSession, makeNonce, makeAad, aeadSeal, aeadOpen,
  p256Sign, p256PubToSec1, Dir,
} from "../crypto.ts";
import { ENVELOPE_VER, FrameType, encodeEnvelope, parseEnvelope } from "../envelope.ts";
import { RemoteSessionCodec } from "../session.ts";
import { MacIdentity, DeviceKeyring } from "../keyring.ts";
import { TicketStore } from "../tickets.ts";
import { ChallengeStore, stepUpMessage } from "../stepup.ts";
import { HandshakeServer } from "../handshake.ts";
import { ControlDispatcher, type RouteDispatch, type DispatchSession } from "../dispatch.ts";
import { RemoteAuditLog } from "../audit.ts";

const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");

function tmp(): string { return mkdtempSync(join(tmpdir(), "eos-hs-")); }

// Minimal device-side crypto mirror of the server handshake + record codec.
class Device {
  priv: KeyObject;
  pubSec1: Buffer;
  devId = "11111111-1111-4111-8111-111111111111";
  label = "test-phone";
  ePubC!: Buffer; eSecC!: Buffer; nC!: Buffer;
  kC2s!: Buffer; kS2c!: Buffer; th3!: Buffer;
  kC2sFinal!: Buffer; kS2cFinal!: Buffer;
  txSeq = 0n;
  constructor() {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.priv = privateKey;
    this.pubSec1 = p256PubToSec1(createPublicKey(privateKey));
  }
  pair1(): object {
    const e = kxKeypair();
    this.ePubC = e.pub; this.eSecC = e.sec; this.nC = randomBytes(16);
    return { v: 1, t: "hs", step: 1, mode: "pair", ePubC: b64u(this.ePubC), nC: b64u(this.nC) };
  }
  pair3(pair2: any, macPub: Buffer, ots: Buffer): object {
    const ePubS = unb64u(pair2.ePubS), nS = unb64u(pair2.nS), encS = unb64u(pair2.encS);
    const { kC2s, kS2c } = kxSession("client", this.ePubC, this.eSecC, ePubS);
    this.kC2s = kC2s; this.kS2c = kS2c;
    const th2 = hash(this.ePubC, this.nC, ePubS, nS);
    const kHsS2c = kdf(kS2c, "eos/v1 hs s2c", th2);
    const s2 = aeadOpen(kHsS2c, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), encS);
    assert.ok(s2, "device opens encS");
    const s2obj = JSON.parse(s2!.toString("utf8"));
    assert.equal(s2obj.iMac, b64u(macPub), "Mac key is the pinned QR key");
    this.th3 = hash(this.ePubC, this.nC, ePubS, nS, encS);
    const kHsC2s = kdf(kC2s, "eos/v1 hs c2s", this.th3);
    const otsProof = keyedHash(ots, this.th3);
    const sigC = p256Sign(this.priv, Buffer.concat([ascii("eos/v1 pair client"), this.th3]));
    const c3 = Buffer.from(JSON.stringify({
      iDev: b64u(this.pubSec1), devId: this.devId, label: this.label,
      sigC: b64u(sigC), ots: b64u(otsProof),
    }), "utf8");
    const encC = aeadSeal(kHsC2s, makeNonce(0, Dir.c2s, 0n), Buffer.alloc(0), c3);
    this.kC2sFinal = kdf(kC2s, "eos/v1 data c2s", this.th3);
    this.kS2cFinal = kdf(kS2c, "eos/v1 data s2c", this.th3);
    return { v: 1, t: "hs", step: 3, mode: "pair", encC: b64u(encC) };
  }
  // Seal a client→server control frame into its outer envelope (c2s).
  send(frame: object, room: string, clientId: Buffer): Buffer {
    const seq = this.txSeq++;
    const aad = makeAad(ENVELOPE_VER, 0, Dir.c2s, seq, room, clientId);
    const ct = aeadSeal(this.kC2sFinal, makeNonce(0, Dir.c2s, seq), aad, Buffer.from(JSON.stringify(frame), "utf8"));
    return encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, epoch: 0, seq, room, clientId, payload: ct });
  }
  // Open a server→client s2c envelope.
  recv(wire: Buffer): any {
    const env = parseEnvelope(wire);
    const aad = makeAad(ENVELOPE_VER, 0, Dir.s2c, env.seq, env.room, env.clientId);
    const pt = aeadOpen(this.kS2cFinal, makeNonce(0, Dir.s2c, env.seq), aad, env.payload);
    assert.ok(pt, "device opens s2c frame");
    return JSON.parse(pt!.toString("utf8"));
  }
  stepUpSig(sessionTH: Buffer, method: string, path: string, body: string, challengeNonce: string, ts: number): string {
    return b64u(p256Sign(this.priv, stepUpMessage({ sessionTH, method, path, body, challengeNonce, ts })));
  }
}

describe("gateway end-to-end: cold pairing + control round-trip + tiers", () => {
  it("pairs, then enforces READ / HIGH+stepup / REFUSED over the record codec", async () => {
    const dir = tmp();
    try {
      const room = "AAAAAAAAAAAAAAAAAAAAAA";
      const clientId = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
      const identity = new MacIdentity(dir);
      const keyring = new DeviceKeyring(dir);
      const tickets = new TicketStore();
      const audit = new RemoteAuditLog(dir);
      const ots = randomBytes(32);
      let now = 1_000_000;
      const clock = () => now;

      // --- COLD PAIRING ---
      const dev = new Device();
      const hs = new HandshakeServer(
        { identity, keyring, tickets, now: clock, burnOts: () => { /* burned */ } },
        { room, clientId, ots },
      );
      const r1 = hs.handle(dev.pair1());
      assert.equal(r1.kind, "reply");
      const pair2 = r1.kind === "reply" ? r1.frame : null;
      const r3 = hs.handle(dev.pair3(pair2, identity.publicSec1(), ots));
      assert.equal(r3.kind, "complete");
      if (r3.kind !== "complete") return;
      const serverCodec: RemoteSessionCodec = r3.codec;
      assert.equal(dev.th3.toString("hex"), serverCodec.sessionTH.toString("hex"), "both sides agree on TH3");
      assert.ok(keyring.find(dev.devId), "device enrolled");

      // Welcome (bearer + ticket) arrives as the first sealed s2c frame.
      const welcomeWire = serverCodec.seal({ t: "reply", correlationId: "pair", status: 200, body: r3.welcome });
      const welcome = dev.recv(welcomeWire);
      assert.equal(welcome.body.bearer.length, 43, "durable bearer is b64u(32)");
      assert.ok(welcome.body.ticket.ticketId, "first resumption ticket delivered");

      // --- DISPATCH WIRING ---
      const calls: Array<{ method: string; path: string; uiToken?: string }> = [];
      const routeDispatch: RouteDispatch = async ({ method, path, uiToken }) => {
        calls.push({ method, path, uiToken });
        return { status: 200, body: { ok: true, path } };
      };
      const dispatcher = new ControlDispatcher({ routeDispatch, keyring, audit, uiToken: "LOCAL-UI-TOKEN", now: clock });
      const session: DispatchSession = {
        devId: serverCodec.devId, sessionTH: serverCodec.sessionTH,
        challenges: new ChallengeStore(), hasCap: (c) => serverCodec.hasCap(c),
      };

      // Drive one control frame through open→dispatch→seal→recv.
      async function control(frame: object): Promise<any> {
        const opened = serverCodec.open(parseEnvelope(dev.send(frame, room, clientId)));
        assert.ok(opened.ok, "server opens the control frame");
        const reply = await dispatcher.handle(session, opened.frame as any);
        return dev.recv(serverCodec.seal(reply));
      }

      // READ → no step-up, dispatched.
      const read = await control({ t: "control", correlationId: crypto.randomUUID(), method: "GET", path: "/workers", body: "{}" });
      assert.equal(read.t, "reply");
      assert.equal(read.status, 200);
      assert.equal(calls.length, 1);

      // HIGH without step-up → STEPUP_REQUIRED, NOT dispatched.
      const hi0 = await control({ t: "control", correlationId: crypto.randomUUID(), method: "DELETE", path: "/workers/abc", body: "{}" });
      assert.equal(hi0.t, "error");
      assert.equal(hi0.code, "STEPUP_REQUIRED");
      assert.equal(calls.length, 1, "high-risk not dispatched without step-up");

      // Request a challenge.
      const ch = await control({ t: "control", correlationId: crypto.randomUUID(), method: "POST", path: "/stepup/challenge", body: "{}" });
      assert.equal(ch.t, "challenge");
      assert.ok(ch.challengeNonce);

      // Sign the exact action + challenge → HIGH dispatched.
      const ts = Math.floor(now / 1000);
      const sig = dev.stepUpSig(serverCodec.sessionTH, "DELETE", "/workers/abc", "{}", ch.challengeNonce, ts);
      const hi1 = await control({
        t: "control", correlationId: crypto.randomUUID(), method: "DELETE", path: "/workers/abc", body: "{}",
        stepUp: { challengeNonce: ch.challengeNonce, ts, sig },
      });
      assert.equal(hi1.t, "reply");
      assert.equal(hi1.status, 200);
      assert.equal(calls.length, 2, "high-risk dispatched after valid step-up");

      // Replaying the consumed challenge → STEPUP_INVALID.
      const replay = await control({
        t: "control", correlationId: crypto.randomUUID(), method: "DELETE", path: "/workers/abc", body: "{}",
        stepUp: { challengeNonce: ch.challengeNonce, ts, sig },
      });
      assert.equal(replay.code, "STEPUP_INVALID");

      // REFUSED route → never dispatched.
      const refused = await control({ t: "control", correlationId: crypto.randomUUID(), method: "POST", path: "/workers/abc/events", body: "{}" });
      assert.equal(refused.t, "error");
      assert.equal(refused.code, "ROUTE_REFUSED");
      assert.equal(calls.length, 2);

      // Audit captured every action.
      const entries = audit.read();
      assert.ok(entries.length >= 5);
      assert.equal(entries.at(-1)?.action, "POST /workers/abc/events");
      assert.equal(entries.at(-1)?.result, "denied");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
