import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const peer = vi.hoisted(() => ({ status: null }));
vi.mock("../state/peerStore.js", () => ({ usePeer: () => peer, refreshPeer: () => Promise.resolve(null) }));

const { RemoteAccessSettings } = await import("./RemoteAccessSettings.jsx");

const host = { id: "a".repeat(64), deviceId: "AAAA-BBBB", name: "Studio", platform: "darwin" };
const status = (patch) => ({
  enabled: true, direct: true, port: 7402, listening: false, host, addrs: [], relay: null, openInvites: 0, devices: [], ...patch,
});
const render = (s) => {
  peer.status = s;
  return renderToStaticMarkup(<RemoteAccessSettings />);
};

describe("RemoteAccessSettings", () => {
  it("a copy that keeps off the network says so, not that the port is taken or the relay unset", () => {
    const html = render(status({ off: "off-network", relay: { url: "wss://relay.example/", online: false } }));
    expect(html).toContain("only the installed Eos on your own data folder lets other computers in");
    expect(html).not.toContain("Couldn&#x27;t open the port");
    expect(html).not.toContain("Not set");
    expect(html).not.toContain("Connecting…");
    expect(html).toContain("wss://relay.example/");
  });

  it("on the network a port that would not open still says so", () => {
    const html = render(status({}));
    expect(html).toContain("Couldn&#x27;t open the port");
    expect(html).toContain("Not set");
  });
});
