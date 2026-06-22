// Golden fixture CI gate (protocol §13.1). Re-derives every committed value
// from crypto.ts + the fixed inputs and asserts byte-equality with the
// committed docs/vectors/ios-remote-v1/vectors.json. A mismatch means the Node
// crypto drifted from the reference bytes the relay and iOS clients gate on —
// the build MUST fail. The dataFrameKa.ciphertextTag check is the go/no-go gate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import {
  Dir, hash, keyedHash, kdf, kxSession, makeNonce, makeAad, aeadSeal, aeadOpen,
  p256Sign, p256Verify, p256PubToSec1, p256PubFromSec1, p256PrivFromPem,
} from "../crypto.ts";

const VEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "vectors", "ios-remote-v1");
const vectors = JSON.parse(readFileSync(join(VEC_DIR, "vectors.json"), "utf8"));
const inputsFile = JSON.parse(readFileSync(join(VEC_DIR, "inputs.json"), "utf8"));

const fromHex = (s: string): Buffer => Buffer.from(s, "hex");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
const b64u = (b: Buffer): string => b.toString("base64url");

const i = vectors.inputs;
const ePubC = fromHex(i.ePubC), eSecC = fromHex(i.eSecC);
const ePubS = fromHex(i.ePubS);
const clientNonce = fromHex(i.clientNonce), serverNonce = fromHex(i.serverNonce);
const ots = fromHex(i.ots);
const clientId = fromHex(i.clientId);

const iMacPriv = p256PrivFromPem(inputsFile.iMacPrivPem);
const iDevPriv = p256PrivFromPem(inputsFile.iDevPrivPem);
const iMacPub = createPublicKey(iMacPriv);
const iDevPub = createPublicKey(iDevPriv);
const sigS = fromHex(inputsFile.sigSHex);
const sigC = fromHex(inputsFile.sigCHex);

describe("golden interop fixture (§9.2)", () => {
  // Recompute the full handshake derivation chain.
  const { kC2s, kS2c } = kxSession("client", ePubC, eSecC, ePubS);
  const th2 = hash(ePubC, clientNonce, ePubS, serverNonce);
  const kHsS2c = kdf(kS2c, "eos/v1 hs s2c", th2);
  const s2 = Buffer.from(JSON.stringify({ iMac: b64u(p256PubToSec1(iMacPub)), sigS: b64u(sigS) }), "utf8");
  const encS = aeadSeal(kHsS2c, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), s2);
  const th3 = hash(ePubC, clientNonce, ePubS, serverNonce, encS);
  const kHsC2s = kdf(kC2s, "eos/v1 hs c2s", th3);
  const otsProof = keyedHash(ots, th3);
  const c3 = Buffer.from(JSON.stringify({
    iDev: b64u(p256PubToSec1(iDevPub)), devId: i.devId, label: i.label,
    sigC: b64u(sigC), ots: b64u(otsProof),
  }), "utf8");
  const encC = aeadSeal(kHsC2s, makeNonce(0, Dir.c2s, 0n), Buffer.alloc(0), c3);
  const kC2sFinal = kdf(kC2s, "eos/v1 data c2s", th3);
  const kS2cFinal = kdf(kS2c, "eos/v1 data s2c", th3);

  it("crypto_kx directional keys match", () => {
    assert.equal(kC2s.toString("hex"), vectors.kx.kC2s);
    assert.equal(kS2c.toString("hex"), vectors.kx.kS2c);
  });

  it("transcript hashes TH2/TH3 match", () => {
    assert.equal(th2.toString("hex"), vectors.transcript.th2);
    assert.equal(th3.toString("hex"), vectors.transcript.th3);
  });

  it("handshake + traffic keys match", () => {
    assert.equal(kHsS2c.toString("hex"), vectors.handshakeKeys.kHsS2c);
    assert.equal(kHsC2s.toString("hex"), vectors.handshakeKeys.kHsC2s);
    assert.equal(kC2sFinal.toString("hex"), vectors.trafficKeys.kC2sFinal);
    assert.equal(kS2cFinal.toString("hex"), vectors.trafficKeys.kS2cFinal);
  });

  it("otsProof (keyed BLAKE2b over TH3) matches", () => {
    assert.equal(otsProof.toString("hex"), vectors.otsProof);
  });

  it("pinned signatures verify (SIGMA-I mutual auth)", () => {
    assert.ok(p256Verify(iMacPub, Buffer.concat([ascii("eos/v1 pair server"), th2]), sigS));
    assert.ok(p256Verify(iDevPub, Buffer.concat([ascii("eos/v1 pair client"), th3]), sigC));
  });

  it("sealed encS/encC reproduce committed ciphertexts", () => {
    assert.equal(encS.toString("hex"), vectors.sealed.encS);
    assert.equal(encC.toString("hex"), vectors.sealed.encC);
  });

  it("GO/NO-GO: {\"t\":\"ka\",\"ts\":0} data-frame ciphertext‖tag matches", () => {
    const plain = Buffer.from('{"t":"ka","ts":0}', "utf8");
    const npub = makeNonce(0, Dir.c2s, 0n);
    const aad = makeAad(0x01, 0, Dir.c2s, 0n, i.room, clientId);
    assert.equal(npub.toString("hex"), vectors.dataFrameKa.npub);
    assert.equal(aad.toString("hex"), vectors.dataFrameKa.aad);
    const ct = aeadSeal(kC2sFinal, npub, aad, plain);
    assert.equal(ct.toString("hex"), vectors.dataFrameKa.ciphertextTag);
    // Round-trip: the committed ciphertext decrypts back under the same key/AAD.
    const opened = aeadOpen(kC2sFinal, npub, fromHex(vectors.dataFrameKa.aad), fromHex(vectors.dataFrameKa.ciphertextTag));
    assert.equal(opened?.toString("utf8"), '{"t":"ka","ts":0}');
  });

  it("AAD tamper is rejected (DECRYPT_FAIL)", () => {
    const npub = makeNonce(0, Dir.c2s, 0n);
    const badAad = makeAad(0x01, 0, Dir.s2c, 0n, i.room, clientId); // flipped dir
    assert.equal(aeadOpen(kC2sFinal, npub, badAad, fromHex(vectors.dataFrameKa.ciphertextTag)), null);
  });

  it("resume-path vector matches (PSK-(EC)DHE KDF composition)", () => {
    const ticketId = fromHex(i.resume.ticketId);
    const psk = fromHex(i.resume.psk);
    const thResume = hash(ticketId, ePubC, clientNonce, ePubS, serverNonce);
    const thWithKx = hash(thResume, kC2s, kS2c);
    const binderC = keyedHash(psk, ascii("eos/v1 resume binderC"), ticketId, ePubC, clientNonce);
    const binderS = keyedHash(psk, ascii("eos/v1 resume binderS"), ticketId, ePubS, serverNonce, ePubC);
    assert.equal(thResume.toString("hex"), vectors.resume.thResume);
    assert.equal(thWithKx.toString("hex"), vectors.resume.thWithKx);
    assert.equal(binderC.toString("hex"), vectors.resume.binderC);
    assert.equal(binderS.toString("hex"), vectors.resume.binderS);
    assert.equal(kdf(psk, "eos/v1 resume data c2s", thWithKx).toString("hex"), vectors.resume.kC2sResume);
    assert.equal(kdf(psk, "eos/v1 resume data s2c", thWithKx).toString("hex"), vectors.resume.kS2cResume);
  });

  it("bodyHash vector matches (§3.4)", () => {
    assert.equal(hash(Buffer.from(i.sampleStepUpBody, "utf8")).toString("hex"), vectors.stepUp.bodyHash);
  });

  it("P-256 SEC1 round-trips through 65-byte point form", () => {
    const sec1 = p256PubToSec1(iMacPub);
    assert.equal(sec1.length, 65);
    assert.equal(sec1[0], 0x04);
    const reimported = p256PubFromSec1(sec1);
    assert.equal(p256PubToSec1(reimported).toString("hex"), sec1.toString("hex"));
  });
});
