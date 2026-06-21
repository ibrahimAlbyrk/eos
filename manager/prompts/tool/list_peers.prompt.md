---
description: "MCP tool — list_peers"
variables:
  - ASK_PEER_TOOL
---

List the peer workers you can consult — your siblings, spawned to collaborate with you. Returns each peer's `{ id, name, state, summary }` — `state` is its live worker-state (`IDLE` peers answer fastest); `summary` is the FIRST line of that peer's directive (160-char slice), so a peer is findable by specialty only if its opener names its domain.

Takes no arguments. Call it before {{ASK_PEER_TOOL}} to pick a peer by `summary`, then pass that peer's `id`. An empty list means you have no collaborate-peers (none were spawned into the peer mesh) — proceed on your own and note it in your report.
