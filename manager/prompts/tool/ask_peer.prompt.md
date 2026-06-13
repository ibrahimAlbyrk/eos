---
description: "MCP tool — ask_peer"
variables:
  - LIST_PEERS_TOOL
  - RESPOND_TO_PEER_TOOL
---

Ask one peer worker a question and BLOCK until it answers — the answer comes back as this tool's result. The answerer is another agent (the peer), not the human.

Pass `peerId` (from {{LIST_PEERS_TOOL}}) and a `question`. Make the question focused and self-contained: the peer cannot see your task, only your question, so include the context it needs to answer.

Use it when you need a fact, decision, or artifact a peer owns and would otherwise guess or re-derive. Do NOT use it to hand the peer your own task, to chat, or to ask something you can determine yourself. One question per call; the peer takes a turn to answer, so expect a wait. If the peer is unavailable or the consult would create a circular wait, you get a short reason instead of an answer — proceed on your best judgment then.

To answer a question another peer sent YOU, use {{RESPOND_TO_PEER_TOOL}}, not this.
