#!/usr/bin/env node
// Writes rust/fixtures/relay: what today's TypeScript puts on the relay wire,
// so the Rust port (crates/eos-relay, crates/eos-mod-remote) can be held to it.
//
//   node rust/tools/relay-vectors/generate.mjs            write the corpus
//   node rust/tools/relay-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 (runs the .ts sources directly) and `npm ci` in contracts/.
//
// envelopes.json  the outer envelope: encodings by relay/envelope.ts and
//                 manager/remote/envelope.ts (which must agree), what each
//                 parses back to, buffers that parse and buffers that do not,
//                 and the relay-control messages as the connector, the peer
//                 pipe and the relay server write them.
// frames.json     the phone's inner frames: server frames as the framer writes
//                 them (plain and deflated), and which client payloads the
//                 gateway takes.
// gateway.json    whole sessions: the TypeScript gateway, bridge, patcher and
//                 live text driven by scripted phones, bus events and route
//                 answers; every frame each phone received, in order.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/relay");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const relayEnv = await load("relay/envelope.ts");
const macEnv = await load("manager/remote/envelope.ts");
const { errorPayload, RelayError } = await load("relay/errors.ts");
const { sha256Hex } = await load("relay/admission.ts");
const { encodeServerFrame, decodeClientFrame } = await load("manager/remote/framer.ts");
const { generatePairing } = await load("manager/remote/qr.ts");
const { runGatewayScenarios } = await import("./gateway.mjs");

const hex = (buf) => Buffer.from(buf).toString("hex");
const { FrameType, Dir } = macEnv;

// ---- envelopes --------------------------------------------------------------

const ROOM = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4";
const CLIENT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const HIGH = Buffer.from("fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0", "hex");

const ENCODE = [
  { type: FrameType.data, dir: Dir.s2c, room: ROOM, clientId: hex(CLIENT), payload: hex(Buffer.from('{"t":"ka","ts":1}')) },
  { type: FrameType.data, dir: Dir.c2s, room: ROOM, clientId: hex(HIGH), payload: "" },
  { type: FrameType.data, dir: Dir.c2s, epoch: 7, seq: "42", room: "AAAAAAAAAAAAAAAAAAAAAA", clientId: hex(CLIENT), payload: "00ff10" },
  { type: FrameType.data, dir: Dir.c2s, seq: "18446744073709551615", room: "r", payload: "" },
  { type: FrameType.data, dir: Dir.s2c, epoch: 255, seq: "72057594037927936", room: "", clientId: hex(CLIENT), payload: "01" },
  { type: FrameType.register, dir: Dir.c2s, room: "r", payload: hex(Buffer.from("{}")) },
  { type: FrameType.join, dir: Dir.c2s, room: "x".repeat(255), payload: hex(Buffer.from("{}")) },
  { type: FrameType.ka, dir: Dir.c2s, room: ROOM, clientId: hex(CLIENT), payload: "" },
  { type: FrameType.error, dir: Dir.s2c, room: "", payload: hex(Buffer.from("{}")) },
  // A room that is not ASCII: each UTF-16 unit keeps its low byte on the way
  // out, and each byte loses its top bit on the way back.
  { type: FrameType.data, dir: Dir.s2c, room: "ünï€😀", clientId: hex(CLIENT), payload: "7b7d" },
];

function encodeBoth(c) {
  const args = {
    type: c.type, dir: c.dir, room: c.room,
    ...(c.epoch !== undefined ? { epoch: c.epoch } : {}),
    ...(c.seq !== undefined ? { seq: BigInt(c.seq) } : {}),
    ...(c.clientId !== undefined ? { clientId: Buffer.from(c.clientId, "hex") } : {}),
    payload: Buffer.from(c.payload, "hex"),
  };
  const a = relayEnv.encodeEnvelope(args);
  const b = macEnv.encodeEnvelope(args);
  if (!a.equals(b)) throw new Error("relay/envelope.ts and manager/remote/envelope.ts disagree");
  return a;
}

function parsed(buf) {
  for (const mod of [relayEnv, macEnv]) {
    try { mod.parseEnvelope(buf); } catch { /* compared below */ }
  }
  const read = (mod) => {
    try {
      const e = mod.parseEnvelope(buf);
      return { ver: e.ver, type: e.type, dir: e.dir, epoch: e.epoch, seq: e.seq.toString(), room: e.room, clientId: hex(e.clientId), payload: hex(e.payload) };
    } catch (e) {
      return { error: e.message };
    }
  };
  const a = read(relayEnv);
  const b = read(macEnv);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("the two parsers disagree");
  return a;
}

const encode = ENCODE.map((c) => {
  const bytes = encodeBoth(c);
  return { ...c, bytes: hex(bytes), parsed: parsed(bytes) };
});

const over = (() => {
  try { macEnv.encodeEnvelope({ type: FrameType.data, dir: Dir.s2c, room: "x".repeat(256), payload: Buffer.alloc(0) }); return null; }
  catch (e) { return e.message; }
})();
const shortId = (() => {
  try { macEnv.encodeEnvelope({ type: FrameType.data, dir: Dir.s2c, room: "r", clientId: Buffer.alloc(15), payload: Buffer.alloc(0) }); return null; }
  catch (e) { return e.message; }
})();

const whole = encodeBoth(ENCODE[2]);
const PARSE = [
  Buffer.alloc(0),
  Buffer.alloc(5),
  Buffer.alloc(12),
  Buffer.alloc(13),               // roomLen 0, no client id
  Buffer.alloc(28),
  Buffer.alloc(29),               // the shortest envelope: empty room, zero id, no payload
  whole.subarray(0, 15),
  whole.subarray(0, whole.length - 3 - 1),
  whole.subarray(0, whole.length - 3),
  // Version, type and direction are read, not judged.
  Buffer.concat([Buffer.from([9, 0x77, 0x05, 3]), Buffer.alloc(8, 0xab), Buffer.from([2, 0xc3, 0xbc]), CLIENT, Buffer.from("zz")]),
  Buffer.concat([Buffer.from([1, 1, 1, 0]), Buffer.alloc(8), Buffer.from([3, 0x80, 0xff, 0x41]), HIGH]),
];
const parse = PARSE.map((buf) => ({ bytes: hex(buf), parsed: parsed(buf) }));

// The relay-control messages, each written by the code path that sends it today.
const OWNER = "b3duZXItc2VjcmV0LW93bmVyLXNlY3JldC1vd25lci1zZWNyZXQ";
const BEARER = "YmVhcmVyLXNlY3JldC1iZWFyZXItc2VjcmV0LWJlYXJlci1zZWM";
const json = (args) => {
  const a = relayEnv.encodeJsonEnvelope(args);
  const b = macEnv.encodeJsonEnvelope(args);
  if (!a.equals(b)) throw new Error("the two JSON encoders disagree");
  return hex(a);
};
const control = {
  about: "who: the sender. Field order is the order the TypeScript writes.",
  room: ROOM, owner: OWNER, bearer: BEARER, bearerHash: sha256Hex(BEARER), clientId: hex(CLIENT),
  // RelayConnector.dial / refreshAllow
  register: json({ type: FrameType.register, room: ROOM, json: { t: "register", room: ROOM, owner: OWNER, allow: [sha256Hex(BEARER)] } }),
  registerNoDevices: json({ type: FrameType.register, room: ROOM, json: { t: "register", room: ROOM, owner: OWNER, allow: [] } }),
  // relay-pipe.ts openRelayPipe
  join: json({ type: FrameType.join, room: ROOM, dir: Dir.c2s, json: { t: "join", room: ROOM, bearer: BEARER } }),
  // relay/server.ts notifyJoined / notify / sendError
  joined: json({ type: FrameType.relayctl, room: ROOM, dir: Dir.s2c, clientId: CLIENT, json: { t: "joined", clientId: CLIENT.toString("base64url"), room: ROOM } }),
  left: json({ type: FrameType.relayctl, room: ROOM, dir: Dir.s2c, clientId: CLIENT, json: { t: "left", clientId: CLIENT.toString("base64url"), room: ROOM } }),
  registered: json({ type: FrameType.relayctl, room: ROOM, dir: Dir.s2c, json: { t: "registered", room: ROOM } }),
  errors: Object.values(RelayError).map((code) => ({
    code,
    bytes: json({ type: FrameType.error, room: code === "FRAME_TOO_LARGE" ? "" : ROOM, json: errorPayload(code, "why") }),
  })),
  // relay-pipe.ts: one chunk of a peer link, each way.
  pipeC2s: hex(macEnv.encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, room: ROOM, clientId: CLIENT, payload: Buffer.from("160303", "hex") })),
  pipeS2c: hex(macEnv.encodeEnvelope({ type: FrameType.data, dir: Dir.s2c, room: ROOM, clientId: CLIENT, payload: Buffer.from("160303", "hex") })),
};

// ---- inner frames -----------------------------------------------------------

const UUID = "3f2b8c1e-9d4a-4f6b-8a1c-0e5d7f9b2a41";
// "$lorem:N" and "$noise:N" stand for N characters of text: repeating words,
// and digits and letters in no pattern. Both sides expand them, so a frame
// around a threshold does not have to be stored.
const lorem = (n) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);
const noise = (n) => {
  let x = 0x9e3779b9;
  let s = "";
  while (s.length < n) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; s += x.toString(36); }
  return s.slice(0, n);
};
function expand(value) {
  if (typeof value === "string") {
    const m = /^\$(lorem|noise):(\d+)$/.exec(value);
    return m ? (m[1] === "lorem" ? lorem : noise)(Number(m[2])) : value;
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}
const reply = (text) => ({ t: "reply", correlationId: UUID, status: 200, body: { text } });
// A reply around `text` is 100 bytes of JSON plus the text.
const SERVER_FRAMES = [
  { t: "ka", ts: 1731400000000 },
  { t: "event", seq: 3, reason: "worker:change", ts: 1731400000001, payload: { workerId: "w-1", state: "IDLE" } },
  { t: "event", seq: 3, reason: "agent:delta", ts: 1731400000002, payload: { workerId: "w-1", blockId: "b1", channel: "text", phase: "append", text: "héllo \u2028 😀" } },
  { t: "patch", seq: 4, resource: "workers", op: "upsert", data: { id: "w-1", name: "A", cost: 0.25, n: 12 } },
  { t: "patch", seq: 5, resource: "pending", op: "remove", data: { id: "p-1" } },
  { t: "snapshot", seq: 5, epoch: "00aa11bb22cc33dd", workers: [], pending: [], live: [], caps: ["focus", "rows", "deflate"] },
  { t: "snapshot", seq: 9, epoch: "00aa11bb22cc33dd", workers: [{ id: "w-1" }], pending: [{ id: "p-1" }],
    live: [{ workerId: "w-1", blockId: "b1", channel: "text", text: "so far" }, { workerId: "w-1", blockId: "b0", channel: "reasoning", text: "", done: true }],
    caps: ["focus", "rows", "deflate"], ptys: [{ id: "pty-1" }], uiConfig: { features: { remote: true } } },
  { t: "rows", seq: 9, workerId: "w-1", rows: [{ id: 12, type: "assistant", payload: "{\"text\":\"hi\"}" }] },
  { t: "rows", seq: 9, workerId: "w-1", rows: [], live: [{ workerId: "w-1", blockId: "b1", channel: "text", text: "so far" }] },
  { t: "reply", correlationId: UUID, status: 200, body: { ok: true } },
  { t: "reply", correlationId: UUID, status: 404, body: { error: "not found", path: "/nope" } },
  { t: "reply", correlationId: UUID, status: 200, body: "plain text" },
  { t: "reply", correlationId: UUID, status: 200, body: [] },
  { t: "asset", correlationId: UUID, status: 200, mime: "image/png", bytesB64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]).toString("base64") },
  { t: "error", code: "ROUTE_REFUSED", message: "route not exposed remotely", correlationId: UUID },
  { t: "error", code: "FRAME_TOO_LARGE", message: "asset exceeds relay envelope limit", correlationId: UUID },
  reply("$lorem:411"),       // 511 bytes: one short of the floor
  reply("$lorem:412"),       // 512 bytes: the floor
  reply("$lorem:2000"),
  reply("$noise:700"),       // text with little to repeat
  reply("$lorem:262044"),    // 256 KiB exactly: the ceiling
  reply("$lorem:262045"),    // one over
];

const server = SERVER_FRAMES.map((template) => {
  const frame = expand(template);
  const plain = encodeServerFrame({ room: ROOM, clientId: CLIENT, frame });
  const packed = encodeServerFrame({ room: ROOM, clientId: CLIENT, frame, compress: true });
  const text = macEnv.parseEnvelope(plain).payload;
  const payload = macEnv.parseEnvelope(packed).payload;
  const compressed = payload[0] === 0x01;
  if (compressed && !inflateRawSync(payload.subarray(1)).equals(text)) throw new Error("deflate round trip");
  const large = text.length > 4096;
  return {
    frame: template,
    jsonBytes: text.length,
    jsonSha256: sha256Hex(text),
    ...(large ? {} : { json: text.toString("utf8"), plain: hex(plain) }),
    // The deflated bytes are zlib's; another implementation's differ. What is
    // pinned: whether the frame is deflated at all, and that these bytes inflate.
    compressed,
    ...(compressed && !large ? { packed: hex(packed) } : {}),
  };
});

const CLIENT_PAYLOADS = [
  '{"t":"ka","ts":0}',
  '{"t":"ka","ts":1731400000000}',
  '{"t":"ka","ts":1.5}',
  '{"t":"ka"}',
  '{"t":"hello"}',
  '{"t":"hello","lastContentId":12,"caps":["focus","rows","deflate"]}',
  '{"t":"hello","lastContentId":null}',
  '{"t":"hello","lastContentId":-1}',
  '{"t":"hello","caps":["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q"]}',
  '{"t":"hello","caps":[1]}',
  '{"t":"hello","extra":true}',
  '{"t":"sub","pty":[]}',
  '{"t":"sub","pty":["pty-1","pty-2"]}',
  '{"t":"sub"}',
  `{"t":"sub","pty":[${Array.from({ length: 33 }, (_, i) => `"p${i}"`).join(",")}]}`,
  '{"t":"focus","active":true}',
  '{"t":"focus","active":true,"worker":"w-1","afterId":40,"pty":null}',
  '{"t":"focus","active":false,"worker":null}',
  '{"t":"focus","active":"yes"}',
  '{"t":"focus","active":true,"afterId":-2}',
  '{"t":"focus","active":true,"afterId":1.5}',
  `{"t":"control","correlationId":"${UUID}","method":"GET","path":"/workers"}`,
  `{"t":"control","correlationId":"${UUID.toUpperCase()}","method":"POST","path":"/workers/w-1/message","body":"{\\"text\\":\\"hi\\"}"}`,
  `{"t":"control","correlationId":"not-a-uuid","method":"GET","path":"/workers"}`,
  `{"t":"control","correlationId":"${UUID}","method":"PATCH","path":"/workers"}`,
  `{"t":"control","correlationId":"${UUID}","method":"get","path":"/workers"}`,
  `{"t":"control","correlationId":"${UUID}","method":"GET"}`,
  `{"t":"control","correlationId":"${UUID}","method":"GET","path":"/workers","body":{}}`,
  '{"t":"snapshot","seq":1,"workers":[],"pending":[]}',
  '{"t":"nope"}',
  '{}',
  '[]',
  'null',
  '"hello"',
  'not json',
  '',
];
const client = CLIENT_PAYLOADS.map((payload) => {
  const env = macEnv.parseEnvelope(macEnv.encodeEnvelope({ type: FrameType.data, dir: Dir.c2s, room: ROOM, clientId: CLIENT, payload: Buffer.from(payload, "utf8") }));
  return { payload, frame: decodeClientFrame(env) };
});

const pairing = [
  { now: 1731400000000, relayUrl: "wss://relay.example.test/", room: ROOM, bearer: BEARER },
  { now: 1731400000999, relayUrl: "wss://relay.example.test/", room: ROOM, bearer: BEARER, ttlMs: 30_500 },
  { now: 1731400000000, relayUrl: "wss://relay.example.test/", room: ROOM, bearer: null },
].map((args) => ({ args, qr: generatePairing(args), json: JSON.stringify(generatePairing(args)) }));

// ---- write ------------------------------------------------------------------

const gateway = await runGatewayScenarios();

const files = {
  "envelopes.json": JSON.stringify({
    about: "bytes are hex. encode: inputs → the envelope both TypeScript codecs write, and what they read back. parse: buffers → fields or the error.",
    encode, parse, errors: { roomTooLong: over, shortClientId: shortId }, control,
  }, null, 1) + "\n",
  "frames.json": JSON.stringify({
    about: "server: frame → its JSON, its envelope, whether the framer deflates it for a device with cap deflate. client: a data payload → the frame the gateway takes, or null.",
    room: ROOM, clientId: hex(CLIENT), server, client, pairing,
  }, null, 1) + "\n",
  "gateway.json": JSON.stringify(gateway, null, 1) + "\n",
};

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(OUT, name);
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) { console.error(`${name} would change`); stale = true; }
  }
  process.exit(stale ? 1 : 0);
}
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(path.join(OUT, name), text);
console.log(`${encode.length} encodings, ${parse.length} parses, ${server.length} server frames, ${client.length} client payloads, ${gateway.scenarios.length} gateway sessions`);
