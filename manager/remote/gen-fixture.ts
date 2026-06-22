// Golden interop fixture generator — protocol spec §9.2.
//
// The daemon (Node) is the PINNED owner of this fixture (§9.2): it generates the
// reference bytes first; relay and iOS reproduce them byte-for-byte. The
// {"t":"ka","ts":0} data-frame ciphertext‖tag is the go/no-go interop gate.
//
// Run from manager/ so sodium-native resolves:  npx tsx remote/gen-fixture.ts
//
// All inputs are fixed (§9.2). The two P-256 identity keypairs and their two
// signatures are randomized, so they are generated ONCE and persisted to
// inputs.json; every later run loads them, making vectors.json deterministic.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";
import {
  Dir, hash, keyedHash, kdf, kxSession, makeNonce, makeAad, aeadSeal,
  p256Sign, p256Verify, p256PubToSec1, p256PrivFromPem,
} from "./crypto.ts";

const VEC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "vectors", "ios-remote-v1");
const INPUTS_PATH = join(VEC_DIR, "inputs.json");
const VECTORS_PATH = join(VEC_DIR, "vectors.json");

const b64u = (b: Buffer): string => b.toString("base64url");
const hex = (b: Buffer): string => b.toString("hex");
const fromHex = (s: string): Buffer => Buffer.from(s, "hex");
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");

// ---- Fixed inputs (§9.2) ---------------------------------------------------

// Device ephemeral = RFC7748 §6.1 "a" pair; Mac ephemeral = "b" pair.
const eSecC = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const ePubC = fromHex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const eSecS = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
const ePubS = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
const clientNonce = fromHex("00112233445566778899aabbccddeeff");
const serverNonce = fromHex("ffeeddccbbaa99887766554433221100");
const ots = Buffer.alloc(32, 0x01);
const room = "AAAAAAAAAAAAAAAAAAAAAA"; // b64u of 16 zero bytes; roomLen = 22 = 0x16
const clientId = fromHex("000102030405060708090a0b0c0d0e0f");
const devId = "00000000-0000-4000-8000-000000000001";
const deviceLabel = "fixture-device";

// Resume-path inputs (fixture-defined; the spec does not pin these).
const ticketId = Buffer.alloc(16, 0x03);
const psk = Buffer.alloc(32, 0x02);
const sampleStepUpBody = '{"signal":"TERM"}'; // for the bodyHash vector (§3.4)

const PAIR_SERVER_MSG = (th2: Buffer): Buffer => Buffer.concat([ascii("eos/v1 pair server"), th2]);
const PAIR_CLIENT_MSG = (th3: Buffer): Buffer => Buffer.concat([ascii("eos/v1 pair client"), th3]);

interface InputsFile {
  note: string;
  iMacPrivPem: string;
  iDevPrivPem: string;
  sigSHex: string;
  sigCHex: string;
}

function genP256Pem(): string {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

function build(): void {
  // Directional session keys (device = client; both sides agree).
  const { kC2s, kS2c } = kxSession("client", ePubC, eSecC, ePubS);

  const th2 = hash(ePubC, clientNonce, ePubS, serverNonce);
  const kHsS2c = kdf(kS2c, "eos/v1 hs s2c", th2);

  // Load or first-time-create the pinned identity keys + signatures. Because
  // TH3 depends on encS which depends on sigS, the first run must sign sigS,
  // build encS+TH3, THEN sign sigC — all before persisting inputs.json.
  let iMacPriv: KeyObject, iDevPriv: KeyObject, sigS: Buffer, sigC: Buffer;
  if (existsSync(INPUTS_PATH)) {
    const raw = JSON.parse(readFileSync(INPUTS_PATH, "utf8")) as InputsFile;
    iMacPriv = p256PrivFromPem(raw.iMacPrivPem);
    iDevPriv = p256PrivFromPem(raw.iDevPrivPem);
    sigS = fromHex(raw.sigSHex);
    sigC = fromHex(raw.sigCHex);
  } else {
    const macPem = genP256Pem();
    const devPem = genP256Pem();
    iMacPriv = p256PrivFromPem(macPem);
    iDevPriv = p256PrivFromPem(devPem);
    sigS = p256Sign(iMacPriv, PAIR_SERVER_MSG(th2));
    // TH3 needs encS which needs sigS — compute it inline to sign sigC.
    const encSForTh3 = sealEncS(kHsS2c, iMacPriv, sigS);
    const th3ForSig = hash(ePubC, clientNonce, ePubS, serverNonce, encSForTh3);
    sigC = p256Sign(iDevPriv, PAIR_CLIENT_MSG(th3ForSig));
    mkdirSync(VEC_DIR, { recursive: true });
    const raw: InputsFile = {
      note: "FIXTURE TEST KEYS — NOT Secure-Enclave keys. P-256 identity keypairs (PKCS8 PEM) + the two pinned ECDSA signatures (ieee-p1363 r‖s hex). Generated once; regenerating shifts every dependent ciphertext.",
      iMacPrivPem: macPem, iDevPrivPem: devPem, sigSHex: hex(sigS), sigCHex: hex(sigC),
    };
    writeFileSync(INPUTS_PATH, JSON.stringify(raw, null, 2) + "\n");
  }

  const iMacPub = createPublicKey(iMacPriv);
  const iDevPub = createPublicKey(iDevPriv);
  const iMacPubSec1 = p256PubToSec1(iMacPub);
  const iDevPubSec1 = p256PubToSec1(iDevPub);

  if (!p256Verify(iMacPub, PAIR_SERVER_MSG(th2), sigS)) {
    throw new Error("pinned sigS does not verify against I_mac — inputs.json inconsistent");
  }

  const s2 = Buffer.from(JSON.stringify({ iMac: b64u(iMacPubSec1), sigS: b64u(sigS) }), "utf8");
  const encS = aeadSeal(kHsS2c, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), s2);

  const th3 = hash(ePubC, clientNonce, ePubS, serverNonce, encS);
  const kHsC2s = kdf(kC2s, "eos/v1 hs c2s", th3);
  const otsProof = keyedHash(ots, th3);

  if (!p256Verify(iDevPub, PAIR_CLIENT_MSG(th3), sigC)) {
    throw new Error("pinned sigC does not verify against I_dev over TH3 — inputs.json inconsistent");
  }

  const c3 = Buffer.from(JSON.stringify({
    iDev: b64u(iDevPubSec1), devId, label: deviceLabel, sigC: b64u(sigC), ots: b64u(otsProof),
  }), "utf8");
  const encC = aeadSeal(kHsC2s, makeNonce(0, Dir.c2s, 0n), Buffer.alloc(0), c3);

  const kC2sFinal = kdf(kC2s, "eos/v1 data c2s", th3);
  const kS2cFinal = kdf(kS2c, "eos/v1 data s2c", th3);

  // GO/NO-GO data-frame gate.
  const kaPlain = Buffer.from('{"t":"ka","ts":0}', "utf8");
  const kaNonce = makeNonce(0, Dir.c2s, 0n);
  const kaAad = makeAad(0x01, 0, Dir.c2s, 0n, room, clientId);
  const kaCt = aeadSeal(kC2sFinal, kaNonce, kaAad, kaPlain);

  // Resume-path vector (§2.3) — exercises the novel PSK-(EC)DHE KDF composition.
  const thResume = hash(ticketId, ePubC, clientNonce, ePubS, serverNonce);
  const thWithKx = hash(thResume, kC2s, kS2c);
  const binderC = keyedHash(psk, ascii("eos/v1 resume binderC"), ticketId, ePubC, clientNonce);
  const binderS = keyedHash(psk, ascii("eos/v1 resume binderS"), ticketId, ePubS, serverNonce, ePubC);
  const kC2sResume = kdf(psk, "eos/v1 resume data c2s", thWithKx);
  const kS2cResume = kdf(psk, "eos/v1 resume data s2c", thWithKx);

  const bodyHash = hash(Buffer.from(sampleStepUpBody, "utf8"));

  const vectors = {
    spec: "docs/ios-remote-protocol.md §9.2 — golden interop fixture v1",
    note: "Daemon (Node sodium-native + built-in crypto) reference bytes. Relay and iOS MUST reproduce these byte-for-byte. dataFrameKa.ciphertextTag is the go/no-go interop gate. Values are lowercase hex unless the name says B64U/Utf8.",
    inputs: {
      ePubC: hex(ePubC), eSecC: hex(eSecC), ePubS: hex(ePubS), eSecS: hex(eSecS),
      clientNonce: hex(clientNonce), serverNonce: hex(serverNonce),
      ots: hex(ots), room, roomLen: room.length, clientId: hex(clientId),
      devId, label: deviceLabel,
      iMacPub: hex(iMacPubSec1), iDevPub: hex(iDevPubSec1),
      sigS: hex(sigS), sigC: hex(sigC),
      resume: { ticketId: hex(ticketId), psk: hex(psk) },
      sampleStepUpBody,
    },
    kx: { kC2s: hex(kC2s), kS2c: hex(kS2c) },
    transcript: { th2: hex(th2), th3: hex(th3) },
    handshakeKeys: { kHsS2c: hex(kHsS2c), kHsC2s: hex(kHsC2s) },
    trafficKeys: { kC2sFinal: hex(kC2sFinal), kS2cFinal: hex(kS2cFinal) },
    otsProof: hex(otsProof),
    sealed: {
      s2Plaintext: s2.toString("utf8"), encS: hex(encS),
      c3Plaintext: c3.toString("utf8"), encC: hex(encC),
    },
    dataFrameKa: {
      gate: true,
      plaintextUtf8: kaPlain.toString("utf8"),
      plaintextHex: hex(kaPlain),
      plaintextLen: kaPlain.length, // 17. NOTE: spec §9.2 annotation "15 bytes" is a miscount; these committed bytes are authoritative.
      key: "kC2sFinal",
      npub: hex(kaNonce),
      aad: hex(kaAad),
      ciphertextTag: hex(kaCt),
    },
    resume: {
      note: "ticketId/psk are fixture-defined inputs. TH_with_kx = BLAKE2b(TH ‖ K_c2s ‖ K_s2c); traffic keys = KDF(key=PSK).",
      thResume: hex(thResume), thWithKx: hex(thWithKx),
      binderC: hex(binderC), binderS: hex(binderS),
      kC2sResume: hex(kC2sResume), kS2cResume: hex(kS2cResume),
    },
    stepUp: { bodyHash: hex(bodyHash) },
  };

  mkdirSync(VEC_DIR, { recursive: true });
  writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`wrote ${VECTORS_PATH}\nka ciphertextTag = ${hex(kaCt)}`);
}

// encS depends only on kHsS2c + (iMacPub, sigS); factored out so the first-run
// signing path can derive TH3 before persisting inputs.json.
function sealEncS(kHsS2c: Buffer, iMacPriv: KeyObject, sigS: Buffer): Buffer {
  const iMacPubSec1 = p256PubToSec1(createPublicKey(iMacPriv));
  const s2 = Buffer.from(JSON.stringify({ iMac: b64u(iMacPubSec1), sigS: b64u(sigS) }), "utf8");
  return aeadSeal(kHsS2c, makeNonce(0, Dir.s2c, 0n), Buffer.alloc(0), s2);
}

build();
