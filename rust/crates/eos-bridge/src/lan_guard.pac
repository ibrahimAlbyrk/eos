// Keeps pages off the local network, and keeps the system's proxy settings.
//
// macOS answers any connection to the local network (an address on the LAN, a `.local`
// name, multicast) with the dialog "Allow Eos to find devices on local networks?". A page
// can cause one with a single request: a script probing 192.168.x.x, a sign-in page looking
// for devices. Chromium's own local-network check runs after the connection is made, which
// is too late for the dialog, so the decision is taken here, before DNS and before connect:
// a request for the local network goes to a proxy address nothing listens on and fails at
// once. Loopback is not the local network and is always reachable (a dev server on
// localhost).
//
// OPEN is true for the profile of a browser view in which the user asked for a page on the
// local network: there the local network is reached directly.
//
// Everything else goes where the system's proxy settings say (SYSTEM: its fixed proxies
// and exceptions, read by the shell), or directly without any.
//
// Chromium evaluates this for every http(s) and WebSocket request of a profile.
var OPEN = __OPEN__;
var SYSTEM = __SYSTEM__;

function FindProxyForURL(url, host) {
  var REFUSE = "PROXY 127.0.0.1:9";
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.localhost$/.test(host) || /^127\./.test(host) || host === "::1") return "DIRECT";
  // Multicast DNS names, bare names the local resolver would search for, LAN addresses.
  var local = isLocalName(host) || isLocalNetwork(host);
  var literal = /^[0-9.]+$/.test(host) || host.indexOf(":") >= 0;
  if (!local && !OPEN && !literal) {
    // A public name can point into the local network.
    var resolved = (typeof dnsResolveEx === "function" ? dnsResolveEx(host) : dnsResolve(host)) || "";
    var addresses = resolved.split(";");
    for (var i = 0; i < addresses.length; i++) {
      if (isLocalNetwork(addresses[i].replace(/^\s+|\s+$/g, ""))) local = true;
    }
  }
  if (local) return OPEN ? "DIRECT" : REFUSE;
  return upstream(url, host);
}

function isLocalName(host) {
  return /\.local$/.test(host) || (host.indexOf(".") < 0 && host.indexOf(":") < 0);
}

// Private (RFC 1918), link-local, multicast and broadcast IPv4; unique-local, link-local
// and multicast IPv6. Carrier-grade NAT space (100.64/10) is routed, not local.
function isLocalNetwork(address) {
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|22[4-9]\.|23[0-9]\.|255\.255\.255\.255$)/.test(address)) return true;
  if (/^(fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:|ff[0-9a-f]{2}:)/.test(address)) return true;
  // An IPv4 address written as IPv6.
  var mapped = /^::ffff:([0-9.]+)$/.exec(address);
  return mapped ? isLocalNetwork(mapped[1]) : false;
}

// What the system's proxy settings say for a host that is not on the local network.
function upstream(url, host) {
  for (var i = 0; i < SYSTEM.except.length; i++) {
    if (excepted(host, SYSTEM.except[i])) return "DIRECT";
  }
  var scheme = url.substring(0, url.indexOf(":")).toLowerCase();
  var proxy = scheme === "http" || scheme === "ws" ? SYSTEM.http : SYSTEM.https;
  if (proxy) return "PROXY " + proxy;
  if (SYSTEM.socks) return "SOCKS5 " + SYSTEM.socks + "; SOCKS " + SYSTEM.socks;
  return "DIRECT";
}

// A system exception: `*.example.com`, a host, or a domain (which covers its subdomains).
function excepted(host, pattern) {
  if (pattern.indexOf("*") >= 0) return shExpMatch(host, pattern);
  return host === pattern || host.slice(-(pattern.length + 1)) === "." + pattern;
}
