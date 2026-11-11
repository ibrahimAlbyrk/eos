// The proxy script that keeps pages off the local network (crates/eos-bridge/src/lan_guard.pac),
// run as Chromium would run it.   usage: node tests/lan_guard_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "crates", "eos-bridge", "src", "lan_guard.pac");
const template = readFileSync(file, "utf8");
const NO_PROXY = { http: null, https: null, socks: null, except: [] };
const names = { "public.example": "93.184.216.34", "rebind.example": "93.184.216.34;192.168.1.20", "v6lan.example": "fd12:3456::1", "gone.example": "" };
// Chromium's own helper, in a few lines.
const shExpMatch = (text, pattern) => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(text);

function pac({ open = false, system = NO_PROXY, resolver = { dnsResolveEx: (host) => names[host] ?? "203.0.113.7" } } = {}) {
  const context = vm.createContext({ ...resolver, shExpMatch });
  vm.runInContext(template.replace("__OPEN__", String(open)).replace("__SYSTEM__", JSON.stringify(system)), context);
  return (host, scheme = "https") => context.FindProxyForURL(`${scheme}://${host}/x`, host);
}
let decisions = 0;
const expect = (decide, host, answer, scheme) => { decisions++; assert.equal(decide(host, scheme), answer, `${scheme ?? "https"}://${host}`); };
const REFUSED = "PROXY 127.0.0.1:9";

const WEB = ["example.com", "public.example", "claude.ai", "8.8.8.8", "100.100.1.1", "172.15.0.1", "172.32.0.1", "11.0.0.1", "[2606:4700::1111]", "gone.example"];
const LOOPBACK = ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.9.9.9", "[::1]"];
const LAN = ["192.168.1.1", "192.168.3.8", "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.1", "169.254.1.1", "224.0.0.251", "239.255.255.250", "255.255.255.255", "[fe80::1]", "[fd00::1]", "[fc00::1]", "[ff02::fb]", "[::ffff:192.168.1.1]"];
const LOCAL_NAMES = ["printer.local", "MacBook-Pro.LOCAL", "router", "nas"];

// ---- guarded (every profile by default): the web and this Mac directly, the local network refused
{
  const guarded = pac();
  for (const host of [...WEB, ...LOOPBACK]) expect(guarded, host, "DIRECT");
  for (const host of [...LAN, ...LOCAL_NAMES]) expect(guarded, host, REFUSED);
  // Names that resolve there.
  for (const host of ["rebind.example", "v6lan.example"]) expect(guarded, host, REFUSED);
  expect(guarded, "192.168.1.1", REFUSED, "ws");
  // Without the extended resolver the plain one is used.
  const plain = pac({ resolver: { dnsResolve: (host) => (host === "rebind.example" ? "10.1.2.3" : "198.51.100.1") } });
  expect(plain, "rebind.example", REFUSED, "http");
  expect(plain, "example.com", "DIRECT", "http");
}

// ---- open (the user sent a view of this profile to the local network): everything directly
{
  const open = pac({ open: true, resolver: { dnsResolveEx: () => assert.fail("an open profile resolves nothing itself") } });
  for (const host of [...WEB, ...LOOPBACK, ...LAN, ...LOCAL_NAMES, "rebind.example"]) expect(open, host, "DIRECT");
}

// ---- the system's proxy settings are kept for the web, never used for the local network
{
  const system = { http: "proxy.example:3128", https: "proxy.example:3129", socks: null, except: ["*.intranet.example", "direct.example"] };
  const guarded = pac({ system });
  expect(guarded, "example.com", "PROXY proxy.example:3129");
  expect(guarded, "example.com", "PROXY proxy.example:3128", "http");
  expect(guarded, "example.com", "PROXY proxy.example:3128", "ws");
  expect(guarded, "example.com", "PROXY proxy.example:3129", "wss");
  for (const host of ["wiki.intranet.example", "direct.example", "www.direct.example", ...LOOPBACK]) expect(guarded, host, "DIRECT");
  expect(guarded, "notdirect.example", "PROXY proxy.example:3129");
  for (const host of ["192.168.1.1", "printer.local", "rebind.example"]) expect(guarded, host, REFUSED);
  const open = pac({ open: true, system });
  for (const host of ["192.168.1.1", "printer.local", "nas", "localhost"]) expect(open, host, "DIRECT");
  expect(open, "example.com", "PROXY proxy.example:3129");

  const socks = pac({ system: { http: null, https: null, socks: "socks.example:1080", except: [] } });
  expect(socks, "example.com", "SOCKS5 socks.example:1080; SOCKS socks.example:1080");
  expect(socks, "10.0.0.1", REFUSED);
}
console.log(`lan guard: ${decisions} decisions ok`);
