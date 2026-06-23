import type { ToolDefinition } from "../types.ts";

export const listPeersDef: ToolDefinition = {
  name: "list_peers",
  visibility: "peer",
  inputSchema: {},
  handler: async (ctx) => {
    const peers = await ctx.api("GET", `/workers/${ctx.selfId}/peers`);
    // An empty list is NOT "you are alone" — only collaborate workers have this
    // tool, so you are in a mesh; your provider peers may simply not have spawned
    // yet (peers can arrive after you). Guide toward the order-independent path
    // instead of returning a bare [] that reads as "no peers exist".
    if (Array.isArray(peers) && peers.length === 0) {
      return "No peers have registered yet — but you ARE in a collaboration group, so your provider peers may still be spawning (they can arrive after you). If you know a peer's name (the orchestrator names your specialists in your directive), call ask_peer with that peerName now — it will block until that peer joins and then answers. Otherwise re-check shortly.";
    }
    return peers;
  },
};
