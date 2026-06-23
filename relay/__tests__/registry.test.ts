import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomRegistry, type RelaySocket } from "../RoomRegistry.ts";
import { sha256Hex } from "../admission.ts";

function fakeSocket(): RelaySocket & { sent: Buffer[] } {
  const sent: Buffer[] = [];
  return { sent, send: (d: Buffer) => sent.push(d) };
}

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";

test("register pins owner via TOFU and re-register replaces the Mac socket", () => {
  const reg = new RoomRegistry();
  const mac1 = fakeSocket();
  const r1 = reg.register(ROOM, "owner-secret", [], mac1);
  assert.deepEqual(r1, { ok: true, replaced: false });

  const mac2 = fakeSocket();
  const r2 = reg.register(ROOM, "owner-secret", [], mac2);
  assert.deepEqual(r2, { ok: true, replaced: true });

  const wrong = reg.register(ROOM, "wrong-owner", [], fakeSocket());
  assert.deepEqual(wrong, { ok: false, code: "OWNER_MISMATCH" });
});

test("operator pre-pin rejects a mismatched first registration", () => {
  const reg = new RoomRegistry({ ownerHashPin: sha256Hex("the-owner") });
  assert.deepEqual(reg.register(ROOM, "the-owner", [], fakeSocket()), { ok: true, replaced: false });

  const reg2 = new RoomRegistry({ ownerHashPin: sha256Hex("the-owner") });
  assert.deepEqual(reg2.register(ROOM, "impostor", [], fakeSocket()), { ok: false, code: "OWNER_MISMATCH" });
});

test("join admits an allowlisted bearer and assigns a 16-byte clientId", () => {
  const reg = new RoomRegistry();
  const mac = fakeSocket();
  reg.register(ROOM, "owner", [sha256Hex("dev-bearer")], mac);

  const dev = fakeSocket();
  const res = reg.join(ROOM, "dev-bearer", dev);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.clientId.length, 16);
    assert.equal(res.mac, mac);
  }
});

test("join denies an unknown bearer and an unregistered room", () => {
  const reg = new RoomRegistry();
  reg.register(ROOM, "owner", [sha256Hex("dev-bearer")], fakeSocket());
  assert.deepEqual(reg.join(ROOM, "stranger", fakeSocket()), { ok: false, code: "BEARER_DENIED" });
  assert.deepEqual(reg.join("ZZZ", "dev-bearer", fakeSocket()), { ok: false, code: "ROOM_NOT_FOUND" });
});

test("allowlist mutation is Mac-only", () => {
  const reg = new RoomRegistry();
  const mac = fakeSocket();
  reg.register(ROOM, "owner", [], mac);
  assert.deepEqual(reg.updateAllow(ROOM, "add", sha256Hex("new-dev"), mac), { ok: true });
  // a non-Mac socket cannot mutate the allowlist
  assert.deepEqual(reg.updateAllow(ROOM, "add", sha256Hex("x"), fakeSocket()), { ok: false, code: "OWNER_MISMATCH" });
  // the added bearer now admits
  assert.equal(reg.join(ROOM, "new-dev", fakeSocket()).ok, true);
});

test("routeData forwards c2s to Mac and s2c to the addressed device", () => {
  const reg = new RoomRegistry();
  const mac = fakeSocket();
  reg.register(ROOM, "owner", [sha256Hex("dev")], mac);
  const dev = fakeSocket();
  const joined = reg.join(ROOM, "dev", dev);
  assert.ok(joined.ok);
  const clientHex = joined.ok ? joined.clientId.toString("hex") : "";

  const up = Buffer.from("c2s-frame");
  assert.deepEqual(reg.routeData(ROOM, 0x00, clientHex, up), { ok: true });
  assert.ok(mac.sent.at(-1)?.equals(up));

  const down = Buffer.from("s2c-frame");
  assert.deepEqual(reg.routeData(ROOM, 0x01, clientHex, down), { ok: true });
  assert.ok(dev.sent.at(-1)?.equals(down));
});

test("dropping a device removes it from routing; dropping Mac keeps the room", () => {
  const reg = new RoomRegistry();
  const mac = fakeSocket();
  reg.register(ROOM, "owner", [sha256Hex("dev")], mac);
  const dev = fakeSocket();
  const joined = reg.join(ROOM, "dev", dev);
  const clientHex = joined.ok ? joined.clientId.toString("hex") : "";

  reg.drop(dev);
  assert.deepEqual(reg.routeData(ROOM, 0x01, clientHex, Buffer.from("x")), { ok: false, code: "ROOM_NOT_FOUND" });

  reg.drop(mac);
  assert.equal(reg.roomCount(), 1); // room survives Mac reconnect
  // join now fails because the Mac socket is gone until re-register
  assert.deepEqual(reg.join(ROOM, "dev", fakeSocket()), { ok: false, code: "ROOM_NOT_FOUND" });
});
