// Relay-mode E2E harness — MANUAL, NOT part of npm test. Boots the FULL Mac-side
// remote stack (gateway + RelayConnector + handshake + dispatch) in mode=relay
// against the LIVE relay, arms a one-time pairing offer (adding the pairing
// bearer to the relay allowlist), and emits the §6 pairing payload to stdout AND
// a file so ios-impl's Simulator can join + pair + control THROUGH the live relay
// — a real cross-process, cross-language end-to-end proof. Control frames hit
// harness-local READ routes (real fleet control comes when the operator arms
// config.remote + restarts Eos; this never touches the prod daemon state).
//
// Run:  npx tsx remote/scripts/relay-e2e-harness.ts
// Stop: Ctrl-C. Payload also written to $EOS_PAIR_OUT (default /tmp/eos-pair.json).

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { Router } from "../../routes/Router.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { startRemoteGateway, type RemoteWiringDeps } from "../wire.ts";

const RELAY = process.env.EOS_RELAY_URL ?? "wss://silver-giraffe-71764.zap.cloud/";
// Predictable, cross-process path so ios-impl can consume it programmatically.
const OUT = process.env.EOS_PAIR_OUT ?? "/tmp/eos-pair.json";

// Harness-local READ surface — real route-handler shape, sample state, so a
// paired device gets genuine READ responses without the prod fleet.
function harnessRouter(): Router {
  const r = new Router();
  r.get("/health", ({ res }) => writeJson(res, 200, { ok: true, harness: true }));
  r.get("/workers", ({ res }) => writeJson(res, 200, [
    { id: "w-demo1", name: "harness-worker", is_orchestrator: 0, state: "IDLE", model: "opus" },
  ]));
  r.get("/orchestrators", ({ res }) => writeJson(res, 200, [
    { id: "o-demo1", name: "harness-orchestrator", is_orchestrator: 1, state: "WORKING", model: "opus" },
  ]));
  r.get("/pending", ({ res }) => writeJson(res, 200, []));
  return r;
}

function main(): void {
  const home = mkdtempSync(join(tmpdir(), "eos-relay-harness-"));
  const room = randomBytes(16).toString("base64url"); // fresh room per run
  const bus = createInMemoryEventBus();
  const log = {
    info: (m: string, f?: Record<string, unknown>) => console.log(`[harness] ${m}`, f ?? ""),
    warn: (m: string, f?: Record<string, unknown>) => console.warn(`[harness] ${m}`, f ?? ""),
  };
  const c: RemoteWiringDeps = {
    config: { remote: { mode: "relay", relay: { url: RELAY, room } }, daemon: { home, port: 7400 } },
    uiToken: "harness", bus, log,
  };

  // Relay mode ignores `server` (RelayConnector dials out); a non-listening
  // server satisfies the signature.
  const server = createServer();
  const gateway = startRemoteGateway(c, harnessRouter(), server);
  if (!gateway) { console.error("FAILED to arm gateway"); process.exit(1); }

  // Give the connector a moment to dial + register, then arm pairing + emit.
  setTimeout(() => {
    const qr = gateway.armPairing({ relay: { url: RELAY, room } });
    const payload = JSON.stringify(qr, null, 2);
    writeFileSync(OUT, payload + "\n");
    console.log("\n===== PAIRING PAYLOAD (scan or consume programmatically) =====");
    console.log(payload);
    console.log(`===== written to ${OUT} =====\n`);
    console.log("[harness] waiting for a device to join + pair through the relay… (Ctrl-C to stop)");
  }, 1500);

  process.on("SIGINT", () => { gateway.stop(); server.close(); process.exit(0); });
}

main();
