---
description: "MCP tool — list_peers"
variables:
  - ASK_PEER_TOOL
---

List the peer workers you can consult — your siblings, spawned to collaborate with you. Returns each peer's `{ id, name, state, summary }` — `state` is its live worker-state (`IDLE` peers answer fastest); `summary` is the FIRST line of that peer's directive (160-char slice), so a peer is findable by specialty only if its opener names its domain.

Takes no arguments. Call it before {{ASK_PEER_TOOL}} to pick a peer by `summary`, then pass that peer's `id`. An empty list does NOT mean you are alone: you are in a collaboration mesh, and your provider peers may simply not have spawned yet (peers can arrive after you). When it is empty, do not give up — if you know a peer's name (the orchestrator names your specialists in your directive), call {{ASK_PEER_TOOL}} with that name and it will block until the peer joins; otherwise re-check shortly.
