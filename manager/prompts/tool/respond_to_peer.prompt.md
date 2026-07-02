---
description: "MCP tool — respond_to_peer"
variables:
  - ASK_PEER_TOOL
---

Answer the peer question delivered to you this turn (it arrived tagged `<agent_message from="<name>">…</agent_message>`). Pass your complete `answer` as one self-contained reply.

This is the ONLY thing that reaches the asking peer — text you write in the turn does not. Call it once, with your full answer, before you end the turn. If you cannot answer, send a one-line reason instead of staying silent. If you end the turn without calling this, the asker is told you did not respond.

To START a new question to a peer (not answer one delivered to you this turn), use {{ASK_PEER_TOOL}} instead — this tool only answers the incoming `<agent_message from="<name>">` peer question.
