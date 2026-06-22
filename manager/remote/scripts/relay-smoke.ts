// Manual live smoke test — NOT part of `npm test` (keeps the suite offline).
// Dials the deployed relay, registers a fresh room, and confirms the relay's
// /health rooms count incremented. Run:  npx tsx remote/scripts/relay-smoke.ts
//
// The relay URL is the deployed box (silver-giraffe-71764.zap.cloud, real
// Let's Encrypt cert). In production this comes from config.remote.relayUrl.

import { randomBytes } from "node:crypto";
import { RelayConnector } from "../RelayConnector.ts";

const WSS = process.env.EOS_RELAY_URL ?? "wss://silver-giraffe-71764.zap.cloud/";
const HEALTH = WSS.replace(/^wss:/, "https:").replace(/\/$/, "") + "/health";

async function health(): Promise<number> {
  const r = await fetch(HEALTH);
  const j = (await r.json()) as { ok: boolean; rooms: number };
  return j.rooms;
}

async function main(): Promise<void> {
  const before = await health();
  console.log(`health(before): rooms=${before}`);

  const room = randomBytes(16).toString("base64url"); // 22 chars
  const owner = randomBytes(32).toString("base64url");
  let registered = false;
  const conn = new RelayConnector({
    url: WSS, room, owner, allow: () => [],
    onJoined: () => {}, onData: () => {},
    onError: (code, msg) => console.log(`relay error: ${code} ${msg}`),
    onRegistered: () => { registered = true; },
    now: () => Date.now(), reconnect: false,
    log: (m, x) => console.log(`[relay] ${m}`, x ?? ""),
  });
  conn.start();

  // Give it up to 8s to connect + register, then re-check health.
  const deadline = Date.now() + 8000;
  while (!registered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!registered) { console.error("FAILED: did not register within 8s"); conn.stop(); process.exit(1); }

  await new Promise((r) => setTimeout(r, 500)); // let the relay record the room
  const after = await health();
  console.log(`health(after):  rooms=${after}  (registered room ${room})`);
  conn.stop();

  if (after > before) { console.log("PASS: relay accepted the registration (rooms incremented)"); process.exit(0); }
  console.error("FAIL: rooms count did not increase"); process.exit(1);
}

void main();
