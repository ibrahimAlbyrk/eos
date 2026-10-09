import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isBlockedAddress, parseIPv6 } from "../genui/net-guard.ts";
import { SafeFetchError, checkUrl, guardedLookup } from "../genui/safe-fetch.ts";

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.168.1.10", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:c0a8:101", "::127.0.0.1",
    "64:ff9b::a00:1", "64:ff9b::192.168.0.1", "2002:c0a8:0101::1", "2002:7f00:1::",
    "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1",
    "[::1]", "not-an-ip", "",
  ];
  for (const a of blocked) it(`refuses ${a || "(empty)"}`, () => assert.equal(isBlockedAddress(a), true));

  const open = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2a00:1450:4001::200e"];
  for (const a of open) it(`allows ${a}`, () => assert.equal(isBlockedAddress(a), false));

  it("parses IPv6 with an embedded dotted quad", () => {
    assert.equal(parseIPv6("::ffff:1.2.3.4"), parseIPv6("::ffff:102:304"));
  });
});

describe("checkUrl", () => {
  it("refuses non-http schemes, credentials and private literals", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/a", "data:image/png;base64,AA", "javascript:alert(1)"]) {
      assert.throws(() => checkUrl(u), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked", u);
    }
    assert.throws(() => checkUrl("http://user:pw@example.com/"), /credentials/);
    // WHATWG URL normalizes the odd IPv4 spellings, so these are all loopback.
    for (const u of ["http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://[::1]:7400/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data"]) {
      assert.throws(() => checkUrl(u), /private or local/, u);
    }
    assert.equal(checkUrl("https://example.com/a.png").hostname, "example.com");
  });
});

describe("guardedLookup", () => {
  const run = (resolve: (h: string) => Promise<Array<{ address: string; family: number }>>, opts: { all?: boolean; family?: number } = {}) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((done) => {
      guardedLookup(resolve, isBlockedAddress)("host.test", opts, (err, address, family) => done({ err, address, family }));
    });

  it("refuses a host when any address is private (DNS rebinding)", async () => {
    const r = await run(async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.5", family: 4 }]);
    assert.ok(r.err instanceof SafeFetchError);
    assert.match(r.err!.message, /192\.168\.0\.5/);
  });

  it("answers both lookup forms with the checked addresses", async () => {
    const addrs = [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }];
    const one = await run(async () => addrs);
    assert.equal(one.err, null);
    assert.equal(one.address, "93.184.216.34");
    assert.equal(one.family, 4);
    const all = await run(async () => addrs, { all: true });
    assert.deepEqual(all.address, addrs);
    const v6 = await run(async () => addrs, { family: 6 });
    assert.equal(v6.address, "2606:2800:220:1::1");
  });
});
