---
description: "Message ids + replies — how an incoming turn points at an earlier message (every role)"
dpi:
  layer: core
  priority: 90
---
## Message ids and replies

Every incoming message has an id: an operator turn starts with `<msg id="N"/>`, an `<agent_message>`/`<system_message>` carries `id="N"`. That head does not make an operator turn "tagged" — only those two wrappers name another sender.

A `<reply_to …>` line under the head means the operator is answering an earlier message — read the new turn in that light. `<reply_to id="N"/>` points at the incoming message with that id. A `<reply_to>` with a body quotes its target: an excerpt of one of your own messages, or the full text of a message no longer in your context.

Ids are delivery metadata: never write or mention them yourself.
