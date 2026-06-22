import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { hash, keyedHash, kdf, kxKeypair, kxSession, makeNonce, aeadOpen, Dir } from "../crypto.ts";
import { handleResume } from "../resume.ts";
import { TicketStore } from "../tickets.ts";
import { ChallengeStore } from "../stepup.ts";
import { ControlDispatcher, type RouteDispatch, type DispatchSession } from "../dispatch.ts";
import { DeviceKeyring } from "../keyring.ts";
import { RemoteAuditLog } from "../audit.ts";

const b64u = (b: Buffer): string => b.toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");

describe("resume (RES-1 → RES-2, §2.3)", () => {
  const room = "AAAAAAAAAAAAAAAAAAAAAA";
  const clientId = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const now = 1_000_000;

  // Device side: build RES-1 + the derived session for a given ticket.
  function res1(ticketIdB64u: string, pskB64u: string) {
    const ticketId = unb64u(ticketIdB64u);
    const psk = unb64u(pskB64u);
    const e = kxKeypair();
    const nC = randomBytes(16);
    const binderC = keyedHash(psk, ascii("eos/v1 resume binderC"), ticketId, e.pub, nC);
    const frame = { v: 1, t: "resume", ticketId: ticketIdB64u, ePubC: b64u(e.pub), nC: b64u(nC), binder: b64u(binderC) };
    return { frame, ePubC: e.pub, eSecC: e.sec, nC, ticketId, psk };
  }

  it("verifies the binder, derives matching keys, rotates the ticket, blocks high-risk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-res-"));
    try {
      const tickets = new TicketStore();
      const { client } = tickets.issue("dev-1", now);
      const ctx = { room, clientId };
      const r = res1(client.ticketId, client.psk);
      const out = handleResume({ tickets, now: () => now }, ctx, r.frame);
      assert.equal(out.kind, "complete");
      if (out.kind !== "complete") return;

      // Device reproduces the resume traffic keys + verifies binderS.
      const ePubS = unb64u(out.frame.ePubS), nS = unb64u(out.frame.nS);
      const { kC2s, kS2c } = kxSession("client", r.ePubC, r.eSecC, ePubS);
      const th = hash(r.ticketId, r.ePubC, r.nC, ePubS, nS);
      const thWithKx = hash(th, kC2s, kS2c);
      const binderS = keyedHash(r.psk, ascii("eos/v1 resume binderS"), r.ticketId, ePubS, nS, r.ePubC);
      assert.equal(out.frame.binder, b64u(binderS), "device accepts the Mac binder");
      assert.equal(out.codec.sessionTH.toString("hex"), thWithKx.toString("hex"), "both sides agree on TH_with_kx");

      // encTicket opens under the DEDICATED key, not the s2c traffic key.
      const kResumeTicket = kdf(r.psk, "eos/v1 resume ticket", thWithKx);
      const opened = aeadOpen(kResumeTicket, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), unb64u(out.frame.encTicket));
      assert.ok(opened, "encTicket opens under K_resume_ticket");
      const fresh = JSON.parse(opened!.toString("utf8"));
      assert.ok(fresh.ticketId && fresh.psk, "fresh rotated ticket delivered");
      assert.notEqual(fresh.ticketId, client.ticketId, "ticket rotated");
      // Sealing under the s2c traffic key would collide at seq0 — assert the keys differ.
      const kS2cFinal = kdf(r.psk, "eos/v1 resume data s2c", thWithKx);
      assert.notEqual(kResumeTicket.toString("hex"), kS2cFinal.toString("hex"));

      // Resumed session is read+lowrisk only: HIGH → CAP_DENIED before step-up.
      const keyring = new DeviceKeyring(dir);
      const audit = new RemoteAuditLog(dir);
      const calls: string[] = [];
      const routeDispatch: RouteDispatch = async ({ path }) => { calls.push(path); return { status: 200, body: { ok: true } }; };
      const dispatcher = new ControlDispatcher({ routeDispatch, keyring, audit, uiToken: "T", now: () => now });
      const session: DispatchSession = {
        devId: out.codec.devId, sessionTH: out.codec.sessionTH,
        challenges: new ChallengeStore(), hasCap: (c) => out.codec.hasCap(c),
      };
      const read = await dispatcher.handle(session, { t: "control", correlationId: crypto.randomUUID(), method: "GET", path: "/workers", body: "{}" } as never);
      assert.equal(read.t, "reply");
      const high = await dispatcher.handle(session, { t: "control", correlationId: crypto.randomUUID(), method: "DELETE", path: "/workers/x", body: "{}" } as never);
      assert.equal(high.t, "error");
      assert.equal((high as { code: string }).code, "CAP_DENIED");
      assert.deepEqual(calls, ["/workers"], "high-risk never dispatched on a resumed session");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a reused ticket burns the family (TICKET_REUSE); a bad binder does NOT consume", () => {
    const tickets = new TicketStore();
    const { client } = tickets.issue("dev-2", now);
    const ctx = { room, clientId };

    // Bad binder → AUTH_FAILED, ticket still live.
    const bad = res1(client.ticketId, client.psk);
    bad.frame.binder = b64u(Buffer.alloc(32, 9));
    assert.equal(handleResume({ tickets, now: () => now }, ctx, bad.frame).kind, "error");

    // Good binder consumes it.
    const ok = res1(client.ticketId, client.psk);
    assert.equal(handleResume({ tickets, now: () => now }, ctx, ok.frame).kind, "complete");

    // Re-presenting the consumed ticket → TICKET_REUSE.
    const again = res1(client.ticketId, client.psk);
    const reuse = handleResume({ tickets, now: () => now }, ctx, again.frame);
    assert.equal(reuse.kind, "error");
    if (reuse.kind === "error") assert.equal(reuse.code, "TICKET_REUSE");
  });
});
