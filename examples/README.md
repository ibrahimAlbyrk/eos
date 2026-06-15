# Examples

Real, unedited output from Eos — each produced from a **single prompt, one shot**, with no follow-up
turns. Eos planned the work, spawned the agents, and delivered the result.

## Witherreach — a survival-RPG design document

One prompt asked Eos to invent an original survival-RPG and write its complete game design document
end to end — orchestrating a fleet of agents: **domain experts** (narrative · survival · RPG/combat ·
tech/co-op · market/business) whose only job was to supply authoritative knowledge, which the
research and writing agents consulted through peer collaboration. In all, **12 agents** ran the
process from start to finish — communicating with one another and coordinating the whole way.

Out came **Witherreach** — a dark-fantasy survival-RPG where the corruption rotting the world is also
the only source of your power — as **21 chapters and a ~64,000-word design bible**.

- [`WITHERREACH-GDD.md`](WITHERREACH-GDD.md) — the full design bible: 21 chapters, ~64,000 words

<sub>The whole prompt</sub>

> *"I'm going to make a survival-RPG but I have no concept — you come up with the idea and write the
> document. Write the GDD and run the entire process. Create specialised agents, each an expert in a
> different field, whose job is to supply the needed information; the research, writing, and other
> agents can consult them. Produce an advanced, high-quality document this way."*

## An Age of Empires-style RTS — playable

A single prompt produced a working Age of Empires-style real-time strategy game, built and shipped in
one pass by **39 agents working in parallel**.

- ▶ **Play:** https://playmore.world/#game/9eb83f07-85d0-46ff-900f-30aaa446a5ae

## DOOM-TS — a browser DOOM, single-player and online multiplayer

Over a sustained, multi-turn session, Eos orchestrated a large fleet of agents to build a complete,
from-scratch **DOOM-style raycaster FPS in TypeScript** — and then took it online — running the whole
arc end to end. Parallel **research** agents, a frozen-contract **scaffold**, then fan-out
implementation of the engine (Canvas 2D raycaster, monster AI, 9 weapons, combat, items, audio, HUD,
**6 original levels**); a **peer-collaboration** level-design pass (specialist designers feeding a
senior designer); and a full **online multiplayer** layer — authoritative Colyseus netcode with
client-side prediction + lag compensation, **co-op** (friendly-fire off) and **PvP deathmatch**, and
an in-browser **room browser** — all while keeping single-player fully playable **offline**. Eos also
**deployed it to a live server** (systemd auto-restart + automatic-HTTPS) and packaged a
self-contained itch.io build.

- ▶ **Play (live):** https://185.249.197.74.sslip.io/
- **Source + screenshots:** https://github.com/ibrahimAlbyrk/doom-ts
