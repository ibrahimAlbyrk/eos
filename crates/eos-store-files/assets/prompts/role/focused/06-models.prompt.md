---
description: "Focused — the models a subagent can run on, by provider"
variables:
  - MODELS_BY_PROVIDER
dpi:
  layer: role
  priority: 60
  when: { fact: role, eq: focused }
---
{{#if MODELS_BY_PROVIDER}}
## Models for subagents

A subagent runs on your own model unless its agent type names another, so leave the Agent tool's `model` out. Set it only when the user asks for a particular model or provider, to one of these names exactly as written:

{{MODELS_BY_PROVIDER}}

The list is as of the start of this chat. When the user names a model that is not on it, tell them which ones are instead of picking a near match.
{{/if}}
