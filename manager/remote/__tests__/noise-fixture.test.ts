// Golden Noise_IK fixture CI gate (connection v2). Re-derives the handshake from
// the fixed X25519 secrets and asserts byte-equality with the committed
// docs/vectors/ios-remote-v2/vectors.json. A mismatch means the Node Noise state
// machine drifted from the reference bytes the Swift client gates on — the build
// MUST fail. handshake.msg1 / msg2 and dataFrameKa.ciphertextTag are the gate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { x25519Pub, makeNonce, makeAad, aeadSeal, Dir, type X25519KeyPair } from "../crypto.ts";
import { NoiseInitiator, NoiseResponder } from "../noise.ts";
import { relayDeviceId, buildEnrollPayload, STEADY_PAYLOAD } from "../identity.ts";

const VEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "vectors", "ios-remote-v2");
const v = JSON.parse(readFileSync(join(VEC_DIR, "vectors.json"), "utf8"));

const fromHex = (s: string): Buffer => Buffer.from(s, "hex");
const kp = (secHex: string): X25519KeyPair => { const sec = fromHex(secHex); return { sec, pub: x25519Pub(sec) }; };

const deviceStatic = kp(v.inputs.deviceStaticSec);
const macStatic = kp(v.inputs.macStaticSec);
const deviceEph = kp(v.inputs.deviceEphSec);
const macEph = kp(v.inputs.macEphSec);
const room = v.inputs.room as string;
const clientId = fromHex(v.inputs.clientId);

describe("golden Noise_IK fixture (connection v2)", () => {
  it("derived public keys match the committed inputs", () => {
    assert.equal(deviceStatic.pub.toString("hex"), v.inputs.deviceStaticPub);
    assert.equal(macStatic.pub.toString("hex"), v.inputs.macStaticPub);
    assert.equal(deviceEph.pub.toString("hex"), v.inputs.deviceEphPub);
    assert.equal(macEph.pub.toString("hex"), v.inputs.macEphPub);
  });

  it("relayDeviceId is BLAKE2b-256(deviceStaticPub) b64u", () => {
    assert.equal(relayDeviceId(deviceStatic.pub), v.derived.relayDeviceIdB64u);
  });

  it("enroll msg1 matches the committed bytes", () => {
    const payload1 = buildEnrollPayload(v.inputs.enrollTokenB64u, v.inputs.label);
    assert.equal(payload1.toString("utf8"), v.derived.enrollPayload1Utf8);
    const init = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
    assert.equal(init.writeMessage1(payload1).toString("hex"), v.handshake.msg1);
  });

  it("steady-state msg1 matches the committed bytes", () => {
    assert.equal(STEADY_PAYLOAD.toString("utf8"), v.derived.steadyPayload1Utf8);
    const init = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
    assert.equal(init.writeMessage1(STEADY_PAYLOAD).toString("hex"), v.handshake.msg1Steady);
  });

  it("responder records the device static, writes the committed msg2, and keys agree", () => {
    const payload1 = buildEnrollPayload(v.inputs.enrollTokenB64u, v.inputs.label);
    const init = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
    const msg1 = init.writeMessage1(payload1);

    const resp = new NoiseResponder(macStatic, macEph);
    const r1 = resp.readMessage1(msg1);
    assert.ok(r1, "readMessage1 must succeed");
    assert.equal(r1!.deviceStaticPub.toString("hex"), v.inputs.deviceStaticPub);

    const { msg2, keys } = resp.writeMessage2(Buffer.alloc(0));
    assert.equal(msg2.toString("hex"), v.handshake.msg2);
    assert.equal(keys.kC2sFinal.toString("hex"), v.splitKeys.kC2sFinal);
    assert.equal(keys.kS2cFinal.toString("hex"), v.splitKeys.kS2cFinal);
    assert.equal(keys.sessionTH.toString("hex"), v.splitKeys.sessionTH);

    // Initiator consumes msg2 and derives the SAME keys.
    const r2 = init.readMessage2(msg2);
    assert.ok(r2, "readMessage2 must succeed");
    assert.equal(r2!.keys.kC2sFinal.toString("hex"), v.splitKeys.kC2sFinal);
    assert.equal(r2!.keys.sessionTH.toString("hex"), v.splitKeys.sessionTH);
  });

  it("transport ka data-frame ciphertext‖tag matches the gate", () => {
    const init = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
    init.writeMessage1(buildEnrollPayload(v.inputs.enrollTokenB64u, v.inputs.label));
    const resp = new NoiseResponder(macStatic, macEph);
    resp.readMessage1(init.writeMessage1(buildEnrollPayload(v.inputs.enrollTokenB64u, v.inputs.label)));
    // Re-run cleanly to obtain agreed keys.
    const i2 = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
    const m1 = i2.writeMessage1(buildEnrollPayload(v.inputs.enrollTokenB64u, v.inputs.label));
    const r2 = new NoiseResponder(macStatic, macEph);
    r2.readMessage1(m1);
    const { msg2, keys } = r2.writeMessage2(Buffer.alloc(0));
    i2.readMessage2(msg2);

    const ka = Buffer.from(v.dataFrameKa.plaintextUtf8, "utf8");
    const ct = aeadSeal(
      keys.kC2sFinal,
      makeNonce(0, Dir.c2s, 0n),
      makeAad(0x01, 0, Dir.c2s, 0n, room, clientId),
      ka,
    );
    assert.equal(ct.toString("hex"), v.dataFrameKa.ciphertextTag);
  });
});
