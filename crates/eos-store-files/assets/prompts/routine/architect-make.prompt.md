---
description: The architect's first message when the user makes a routine from a sentence
variables:
  - SENTENCE
  - ROUTINES
  - CAPABILITIES
---
The user wants a new routine:

<request>
{{SENTENCE}}
</request>

Routines the user already has (do not make one that repeats them):

<routines>
{{ROUTINES}}
</routines>

What Eos can reach:

<capabilities>
{{CAPABILITIES}}
</capabilities>

Propose a first blueprint as soon as you can, then ask at most the one question that decides its shape.
