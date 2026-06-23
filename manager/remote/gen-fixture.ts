// Golden Noise_IK interop fixture generator — connection v2
// (docs/ios-remote-connection-v2.md §INTEROP).
//
// The daemon (Node) is the PINNED owner of this fixture: it generates the
// reference bytes; the Swift client reproduces them byte-for-byte before any
// on-device run (the same method that proved v1's crypto). Everything derives
// from FIXED X25519 secret scalars (no signatures, no randomness), so the
// fixture is fully deterministic.
//
// The Noise handshake msg1/msg2 + the transport `ka` data-frame ciphertext‖tag
// are the go/no-go interop gate.
//
// Run from manager/ so sodium-native resolves:  npx tsx remote/gen-fixture.ts

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, x25519Pub, makeNonce, makeAad, aeadSeal, Dir, type X25519KeyPair } from "./crypto.ts";
import { NoiseInitiator, NoiseResponder } from "./noise.ts";
import { relayDeviceId, buildEnrollPayload, STEADY_PAYLOAD } from "./identity.ts";

const VEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "vectors", "ios-remote-v2");
const VECTORS_PATH = join(VEC_DIR, "vectors.json");

const hex = (b: Buffer): string => b.toString("hex");
const fromHex = (s: string): Buffer => Buffer.from(s, "hex");

// ---- Fixed inputs (deterministic) ------------------------------------------
// Four X25519 secret scalars; pubs are derived. Distinct, human-recognizable.
const kp = (sec: Buffer): X25519KeyPair => ({ sec, pub: x25519Pub(sec) });

const deviceStatic = kp(fromHex("a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"));
const macStatic = kp(fromHex("b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"));
const deviceEph = kp(fromHex("c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"));
const macEph = kp(fromHex("d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3"));

const enrollToken = "ZW9zLWVucm9sbC10b2tlbi1maXh0dXJl"; // b64u, fixed
const label = "fixture-iphone";
const room = "AAAAAAAAAAAAAAAAAAAAAA"; // b64u of 16 zero bytes; roomLen 22
const clientId = fromHex("000102030405060708090a0b0c0d0e0f");

function build(): void {
  const devId = relayDeviceId(deviceStatic.pub);

  // ENROLL handshake (msg1 carries the one-time token + label).
  const enrollPayload1 = buildEnrollPayload(enrollToken, label);
  const init = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
  const msg1 = init.writeMessage1(enrollPayload1);

  const resp = new NoiseResponder(macStatic, macEph);
  const r1 = resp.readMessage1(msg1);
  if (!r1) throw new Error("responder readMessage1 failed");
  if (!r1.deviceStaticPub.equals(deviceStatic.pub)) throw new Error("device static mismatch");
  if (r1.payload1.toString("utf8") !== enrollPayload1.toString("utf8")) throw new Error("payload1 mismatch");

  const { msg2, keys: rk } = resp.writeMessage2(Buffer.alloc(0));
  const r2 = init.readMessage2(msg2);
  if (!r2) throw new Error("initiator readMessage2 failed");
  const ik = r2.keys;
  if (!ik.kC2sFinal.equals(rk.kC2sFinal) || !ik.kS2cFinal.equals(rk.kS2cFinal) || !ik.sessionTH.equals(rk.sessionTH)) {
    throw new Error("split-key disagreement between initiator and responder");
  }

  // GO/NO-GO transport data-frame gate: device→Mac ka, c2s seq0.
  const kaPlain = Buffer.from('{"t":"ka","ts":0}', "utf8");
  const kaNonce = makeNonce(0, Dir.c2s, 0n);
  const kaAad = makeAad(0x01, 0, Dir.c2s, 0n, room, clientId);
  const kaCt = aeadSeal(ik.kC2sFinal, kaNonce, kaAad, kaPlain);

  // STEADY-STATE handshake (no token) — msg1 differs only in payload1 bytes.
  const initS = new NoiseInitiator(deviceStatic, macStatic.pub, deviceEph);
  const msg1Steady = initS.writeMessage1(STEADY_PAYLOAD);

  const vectors = {
    spec: "docs/ios-remote-connection-v2.md — Noise_IK golden interop fixture v2",
    note: "Daemon (Node) reference bytes for Noise_IK_25519_XChaChaPoly_BLAKE2b. Swift MUST reproduce these byte-for-byte. handshake.msg1 + handshake.msg2 + dataFrameKa.ciphertextTag are the go/no-go gate. All values lowercase hex unless the name says B64u/Utf8.",
    inputs: {
      deviceStaticSec: hex(deviceStatic.sec), deviceStaticPub: hex(deviceStatic.pub),
      macStaticSec: hex(macStatic.sec), macStaticPub: hex(macStatic.pub),
      deviceEphSec: hex(deviceEph.sec), deviceEphPub: hex(deviceEph.pub),
      macEphSec: hex(macEph.sec), macEphPub: hex(macEph.pub),
      enrollTokenB64u: enrollToken, label, room, roomLen: room.length, clientId: hex(clientId),
    },
    derived: {
      relayDeviceIdB64u: devId,
      enrollPayload1Utf8: enrollPayload1.toString("utf8"),
      steadyPayload1Utf8: STEADY_PAYLOAD.toString("utf8"),
    },
    handshake: {
      msg1: hex(msg1),
      msg1Steady: hex(msg1Steady),
      msg2: hex(msg2),
    },
    splitKeys: {
      kC2sFinal: hex(ik.kC2sFinal),
      kS2cFinal: hex(ik.kS2cFinal),
      sessionTH: hex(ik.sessionTH),
    },
    dataFrameKa: {
      gate: true,
      plaintextUtf8: kaPlain.toString("utf8"),
      key: "kC2sFinal",
      npub: hex(kaNonce),
      aad: hex(kaAad),
      ciphertextTag: hex(kaCt),
    },
  };

  mkdirSync(VEC_DIR, { recursive: true });
  writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`wrote ${VECTORS_PATH}\nmsg1 = ${hex(msg1)}\nka ciphertextTag = ${hex(kaCt)}`);
}

build();
