// Today's TypeScript peer code as a test partner for the Rust one.
//
// The Rust tests start this with `node run.mjs` and talk to it in JSON lines:
// each line in is `{ seq, cmd, ...args }`, each line out `{ seq, ok, ...result }`
// or `{ seq, ok: false, error }`. Everything runs on loopback, on identities and
// folders the test made; nothing here reads the real data folder.

import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity, loadOrCreateRelayRoom,
} from "../../../../../infra/src/peer/stores.ts";

import { Mac } from "./mac.ts";

type Args = Record<string, any>;
type Command = (args: Args) => unknown | Promise<unknown>;

const commands: Record<string, Command> = {
  // The identity in `dir`, minted when the folder has none — and proof that
  // Node's own crypto accepts the files (key matches certificate, self-signed).
  identity({ dir }) {
    const id = loadOrCreateIdentity(dir);
    const cert = new X509Certificate(id.certPem);
    const key = createPrivateKey(id.keyPem);
    return {
      fingerprint: id.fingerprint,
      keyMatches: cert.checkPrivateKey(key),
      selfSigned: cert.verify(cert.publicKey),
      subject: cert.subject,
      validTo: cert.validTo,
      keyType: key.asymmetricKeyType,
      curve: key.asymmetricKeyDetails?.namedCurve ?? null,
    };
  },

  "stores.write"({ dir, devices = [], invites = [], hosts = [] }) {
    const d = createPairedDeviceStore(dir);
    for (const x of devices) d.upsert(x);
    const i = createOpenInviteStore(dir);
    for (const x of invites) i.upsert(x);
    const h = createKnownHostStore(dir);
    for (const x of hosts) h.upsert(x);
    return { relayRoom: loadOrCreateRelayRoom(dir) };
  },

  "stores.read"({ dir }) {
    return {
      devices: createPairedDeviceStore(dir).list(),
      invites: createOpenInviteStore(dir).list(),
      hosts: createKnownHostStore(dir).list(),
      relayRoom: loadOrCreateRelayRoom(dir),
      raw: Object.fromEntries(["devices.json", "invites.json", "hosts.json", "relay-room.json"].map((f) => {
        try { return [f, readFileSync(join(dir, f), "utf8")]; } catch { return [f, null]; }
      })),
    };
  },
};

// ---- whole computers (mac.ts), named by the test -----------------------------

const macs = new Map<string, Mac>();
const mac = (name: string): Mac => {
  const found = macs.get(name);
  if (!found) throw new Error(`no computer called ${name}`);
  return found;
};

Object.assign(commands, {
  async "mac.start"({ name, dir, hosting, direct, relayUrl }: Args) {
    const started = await Mac.start({ dir, name, hosting, direct, relayUrl });
    macs.set(name, started);
    return { fingerprint: started.id(), facadePort: started.facadePort, status: started.host.status() };
  },
  "mac.invite": ({ name }: Args) => mac(name).host.createInvite(),
  "mac.cancelInvites": ({ name }: Args) => ({ cancelled: mac(name).host.cancelInvites() }),
  "mac.pair": async ({ name, invite, alias, mutual }: Args) => ({ view: await mac(name).pair(invite, alias, mutual) }),
  "mac.status": ({ name }: Args) => ({ status: mac(name).host.status() }),
  "mac.hosts": ({ name }: Args) => ({ hosts: mac(name).links.list() }),
  "mac.host": ({ name, id }: Args) => ({ host: mac(name).links.get(id) }),
  "mac.revoke": ({ name, fp }: Args) => ({ revoked: mac(name).host.revoke(fp) }),
  "mac.disconnect": ({ name, fp }: Args) => ({ disconnected: mac(name).host.disconnect(fp) }),
  "mac.reconnect": ({ name, id }: Args) => ({ known: mac(name).links.reconnect(id) }),
  "mac.forget": ({ name, id }: Args) => ({ forgotten: mac(name).links.forget(id) }),
  "mac.updateHost": ({ name, id, patch }: Args) => ({ host: mac(name).links.update(id, patch) }),
  // Flips the configuration; `apply: false` leaves the listener as it is, the way a
  // connection sees the switch before the daemon applied it.
  async "mac.config"({ name, patch, apply }: Args) {
    Object.assign(mac(name).config, patch);
    if (apply !== false) await mac(name).host.reconcile();
    return { status: mac(name).host.status() };
  },
  "mac.seen": ({ name }: Args) => ({ seen: mac(name).seen }),
  "mac.notes": ({ name }: Args) => ({ notes: mac(name).notes }),
  "mac.raise": ({ name, payloads }: Args) => { mac(name).raising.push(...payloads); return {}; },
  "mac.viewToken": ({ name, id }: Args) => ({ token: mac(name).viewTokens.mint(id) }),
  "mac.fetch": async ({ name, ...request }: Args) => ({ response: await mac(name).fetch(request as never) }),
  async "mac.stop"({ name }: Args) {
    await mac(name).stop();
    macs.delete(name);
    return {};
  },
});

const out = (line: unknown): void => { process.stdout.write(JSON.stringify(line) + "\n"); };

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg: Args;
  try { msg = JSON.parse(line) as Args; } catch { return; }
  const { seq, cmd, ...args } = msg;
  const run = commands[cmd as string];
  if (!run) { out({ seq, ok: false, error: `unknown command ${String(cmd)}` }); return; }
  Promise.resolve()
    .then(() => run(args))
    .then((result) => out({ ...(result as object ?? {}), seq, ok: true }))
    .catch((e: unknown) => out({ seq, ok: false, error: e instanceof Error ? e.message : String(e), status: (e as { status?: number })?.status ?? null }));
}).on("close", () => {
  // The test went away: no listener and no link stays behind.
  void Promise.allSettled([...macs.values()].map((m) => m.stop())).then(() => process.exit(0));
});

out({ ready: true });
